// =============================================================================
// DurableNetwork
// =============================================================================
// A `Network` whose server runs in this process, against a durable log.
//
// This is the "library version" of the Resonate server: the protocol machine,
// the commit path, the timeout sweeper and the message transport all live in
// the SDK, and the only external dependency is whatever backs the
// {@link OriginLog}. Swap `MemoryLog` for a JetStream-backed log and the same
// code becomes a distributed deployment with no separate server binary.
//
// Compare the other implementations:
//   - `LocalNetwork`    — same machine, no durability, single process.
//   - `HttpNetwork`     — protocol logic in a remote server.
//   - `NatsNetwork`     — protocol logic in a remote `resonate-on-nats`.
//   - `PostgresNetwork` — protocol logic in Postgres stored procedures.
//
// Delivery is at-least-once. A message is durable in the log before it is
// published, and `recover` republishes anything a crash left unflushed, so a
// lineage can never be stranded by a process dying between commit and publish.
// Duplicates are already tolerated: a stale `execute` loses the version check
// on `task.acquire` and is answered with a 409.

import { randomUUID } from "../platform.js";
import { assert } from "../util.js";
import type { Network } from "./network.js";
import { MemoryLog, type OriginLog, type SnapshotStore } from "./server/log.js";
import { OriginRuntime, type Transport } from "./server/runtime.js";
import { isResponse, type Message, type Request, type Response } from "./types.js";

export interface DurableNetworkConfig {
  /** Durable log backing the server. Defaults to an in-process memory log. */
  log?: OriginLog;
  /** Optional checkpoint store; without it the log is replayed in full. */
  snapshots?: SnapshotStore;
  pid?: string;
  group?: string;
  /** How often to fire due timeouts, in milliseconds. */
  sweepInterval?: number;
  /** Wall clock, injectable so tests can drive time deterministically. */
  now?: () => number;
}

export class DurableNetwork implements Network {
  readonly unicast: string;
  readonly anycast: string;

  private readonly runtime: OriginRuntime;
  private readonly log: OriginLog;
  private readonly group: string;
  private readonly pid: string;
  private readonly sweepInterval: number;
  private readonly now: () => number;

  private subscribers: Array<(msg: Message) => void> = [];
  private sweepTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor({
    log = new MemoryLog(),
    snapshots,
    pid = randomUUID().replace(/-/g, ""),
    group = "default",
    sweepInterval = 1000,
    now = () => Date.now(),
  }: DurableNetworkConfig = {}) {
    this.group = group;
    this.pid = pid;
    this.sweepInterval = sweepInterval;
    this.now = now;
    this.unicast = `local://uni@${group}/${pid}`;
    this.anycast = `local://any@${group}/${pid}`;

    const transport: Transport = {
      publish: async (address, message) => this.deliver(address, message),
    };
    this.log = log;
    this.runtime = new OriginRuntime({ log, snapshots, transport });
  }

  match(target: string): string {
    return `local://any@${target}`;
  }

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.sweepTimer = setInterval(() => {
      // Sweep failures must not take down the process; the next sweep retries,
      // and nothing is lost because due timeouts stay due.
      void this.runtime.sweep(this.now()).catch(() => {});
    }, this.sweepInterval);
    // Republish anything a previous process committed but never delivered.
    await this.recoverAll();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.subscribers = [];
    this.started = false;
  }

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    const { corrId, version } = req.head;
    const response = await this.runtime.apply(this.now(), req);

    const res = { kind: response.kind, head: { corrId, status: response.head.status, version }, data: response.data };
    assert(isResponse(res));
    return res as Extract<Response, { kind: K }>;
  };

  recv(callback: (msg: Message) => void): void {
    this.subscribers.push(callback);
  }

  /** Fire due timeouts immediately rather than waiting for the sweep. */
  async sweep(now: number = this.now()): Promise<number> {
    return this.runtime.sweep(now);
  }

  /** Republish committed-but-unflushed messages across every origin. */
  async recoverAll(): Promise<number> {
    let sent = 0;
    for (const origin of await this.log.origins()) {
      sent += await this.runtime.recover(origin);
    }
    return sent;
  }

  private deliver(address: string, message: Message): void {
    // Addresses are `local://{uni|any}@{group}[/{pid}]`. A unicast message is
    // for this process only; an anycast message is for any member of the group.
    if (!this.addressedToUs(address)) return;
    for (const cb of this.subscribers) cb(message);
  }

  private addressedToUs(address: string): boolean {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return false;
    }
    if (url.hostname !== this.group) return false;
    if (url.username === "uni") {
      return url.pathname === `/${this.pid}`;
    }
    // Anycast: any member of the group may take it. With a single process in
    // the group that is always us; a broker-backed transport is what makes
    // anycast meaningfully competitive between processes.
    return url.username === "any";
  }
}
