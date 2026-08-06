// =============================================================================
// DurableNetwork
// =============================================================================
// A `Network` whose server runs in this process, against a durable log.
//
// This is the "library version" of the Resonate server: the protocol machine,
// the commit path, the timer registry and the message transport all live in the
// SDK, and the only external dependencies are whatever back the
// {@link OriginLog} and {@link TimerService}. Swap the in-memory defaults for
// broker-backed ones and the same code becomes a distributed deployment with no
// separate server binary.
//
// Liveness comes from armed deadlines, never from a scan. Every recovery path in
// the protocol bottoms out in a timer, so each lineage registers a single
// deadline with an always-running component, armed *before* the commit that
// needs it. Firing early is free; firing late or not at all hangs a workflow
// forever. The O(all origins) `sweep` remains available as an operator-facing
// reconciliation pass, but nothing depends on it and it is off by default.
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
import type { NatsMessageSource } from "./server/nats-binding.js";
import { OriginRuntime, type Transport } from "./server/runtime.js";
import { MemoryTimerService, type TimerService } from "./server/timer.js";
import { isMessage, isResponse, type Message, type Request, type Response } from "./types.js";

export interface DurableNetworkConfig {
  /** Durable log backing the server. Defaults to an in-process memory log. */
  log?: OriginLog;
  /** Optional checkpoint store; without it the log is replayed in full. */
  snapshots?: SnapshotStore;
  pid?: string;
  group?: string;
  /**
   * Registers each lineage's deadline. Defaults to an in-process timer.
   *
   * This is the liveness root: it is the only thing that restarts a stalled
   * lineage. A broker-backed implementation makes deadlines durable and fires
   * them with no application process running; the in-process default does not
   * survive process death, and relies on the re-arm that happens whenever a
   * lineage is materialized.
   */
  timers?: TimerService;
  /**
   * Delivers everything this process consumes from NATS — broker-fired ticks
   * and inbound worker messages — over a single consumer.
   *
   * Without one, a fired deadline is recorded and never acted on: the broker
   * wakes up on time and the lineage still hangs. The in-process default timer
   * calls back directly and needs no source; a broker-backed timer does.
   */
  messages?: NatsMessageSource;
  /**
   * Interval for the reconciliation sweep, in milliseconds. Disabled by
   * default: the sweep is an O(all origins) scan and must not be the mechanism
   * liveness depends on. Enable it only as a slow backstop.
   */
  sweepInterval?: number;
  /** Wall clock, injectable so tests can drive time deterministically. */
  now?: () => number;
}

export class DurableNetwork implements Network {
  readonly unicast: string;
  readonly anycast: string;

  private readonly runtime: OriginRuntime;
  private readonly log: OriginLog;
  private readonly timers: TimerService;
  private readonly messages?: NatsMessageSource;
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
    timers,
    messages,
    sweepInterval = 0,
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
    // The timer fires the lineage's tick directly: no scan, no discovery. The
    // deadline was armed before the commit that needed it, so a fire can be
    // spurious but never missing.
    this.timers =
      timers ??
      new MemoryTimerService((origin, at) => {
        void this.runtime.tick(origin, Math.max(at, this.now())).catch(() => {});
      }, now);
    this.messages = messages;
    this.runtime = new OriginRuntime({ log, snapshots, transport, timers: this.timers });
  }

  match(target: string): string {
    return `local://any@${target}`;
  }

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.sweepInterval > 0) {
      // Optional backstop only. Liveness comes from armed deadlines; this exists
      // for operators who want a belt-and-braces reconciliation pass.
      this.sweepTimer = setInterval(() => {
        void this.runtime.sweep(this.now()).catch(() => {});
      }, this.sweepInterval);
    }
    // One consumer, both roles: broker-fired ticks drive the machine's timeout
    // transition, inbound messages reach recv callbacks. Without this the timer
    // is inert — the broker wakes on time and the lineage still hangs.
    await this.messages?.start({
      onTick: async (origin) => {
        await this.runtime.tick(origin, this.now());
      },
      onMessage: (raw) => {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(raw));
          if (isMessage(parsed)) for (const cb of this.subscribers) cb(parsed);
        } catch {
          /* not a protocol message; ignore */
        }
      },
    });
    // Republish anything a previous process committed but never delivered.
    await this.recoverAll();
  }

  async stop(): Promise<void> {
    await this.messages?.stop();
    if (this.timers instanceof MemoryTimerService) this.timers.stop();
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
