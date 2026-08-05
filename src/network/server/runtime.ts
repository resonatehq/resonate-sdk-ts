// =============================================================================
// ORIGIN RUNTIME — load, dispatch, commit, flush
// =============================================================================
//
// The runtime turns the pure machine into a durable service. Per request:
//
//   1. materialize the origin (cached machine, else snapshot + log tail)
//   2. dispatch through the machine, producing a response and a change batch
//   3. append the batch to the log, conditional on the materialized head
//   4. publish the batch's messages, advancing a flush cursor
//
// Steps 3 and 4 are deliberately ordered and deliberately *not* atomic with each
// other — but the messages are already durable in the log by the time step 4
// runs, so a crash between them loses nothing. `recover` republishes from the
// flush cursor, making delivery at-least-once. Duplicate `execute` messages are
// already tolerated by the protocol: a stale version fails `task.acquire` with
// a 409.
//
// On conflict the cached machine is discarded, not reused. `Server.apply`
// mutates in place, so a machine whose append was rejected has applied a
// transition that was never committed and is unsafe to keep.

import type { Change, Server, TimeoutMode } from "../local.js";
import type { Message, Request, Response } from "../types.js";
import { ConflictError, type OriginLog, type SnapshotStore } from "./log.js";
import { fold, hydrate, snapshot } from "./state.js";
import type { TimerService } from "./timer.js";

/** Where an outgoing message goes. */
export interface Transport {
  publish(address: string, message: Message): Promise<void>;
}

/** Collects published messages; the local and test transports both use it. */
export class CollectingTransport implements Transport {
  readonly sent: { address: string; message: Message }[] = [];
  async publish(address: string, message: Message): Promise<void> {
    this.sent.push({ address, message });
  }
}

export interface RuntimeOptions {
  log: OriginLog;
  snapshots?: SnapshotStore;
  transport?: Transport;
  /** Registers each lineage's deadline with an always-running component. */
  timers?: TimerService;
  timeoutMode?: TimeoutMode;
  /** Attempts before an append is abandoned. Matches the Go server's 5. */
  maxAttempts?: number;
  /** Log entries an origin may accumulate before a snapshot is taken. */
  snapshotEvery?: number;
}

interface Materialized {
  server: Server;
  seq: number;
  /** Highest sequence whose messages have been handed to the transport. */
  flushed: number;
  /** Entries appended since the last snapshot. */
  sinceSnapshot: number;
}

/** Derive the lineage root: everything before the first `.`. */
export function originOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * The routing origin for a request — the lineage whose state it touches.
 * Mirrors `routingOrigin` in `nats.ts`, which the remote client already uses to
 * pick a partition, so a request routes to the same place whichever side of the
 * wire computes it.
 */
export function routingOrigin(req: Request): string {
  switch (req.kind) {
    case "promise.get":
    case "promise.create":
    case "promise.settle":
    case "task.get":
    case "task.acquire":
    case "task.release":
    case "task.suspend":
    case "task.halt":
    case "task.continue":
    case "task.fulfill":
    case "task.fence":
      return originOf(req.data.id);
    case "promise.register_callback":
    case "promise.register_listener":
      return originOf(req.data.awaited);
    case "task.create":
      return originOf(req.data.action.data.id);
    case "task.heartbeat":
      return originOf(req.data.tasks[0]?.id ?? "");
    default:
      return "default";
  }
}

function messagesOf(changes: Change[]): { address: string; message: Message }[] {
  const out: { address: string; message: Message }[] = [];
  for (const change of changes) {
    if (change.kind === "message.send") out.push({ address: change.address, message: change.message });
  }
  return out;
}

export class TooManyConflictsError extends Error {
  constructor(origin: string, attempts: number) {
    super(`gave up committing to origin "${origin}" after ${attempts} attempts`);
    this.name = "TooManyConflictsError";
  }
}

export class OriginRuntime {
  private readonly log: OriginLog;
  private readonly snapshots?: SnapshotStore;
  private readonly transport?: Transport;
  private readonly timers?: TimerService;
  private readonly timeoutMode?: TimeoutMode;
  private readonly maxAttempts: number;
  private readonly snapshotEvery: number;

  private cache = new Map<string, Materialized>();
  // Serializes requests per origin *within this process*. Cross-process races
  // still resolve through the log's conditional append, but same-process
  // concurrency — the common case for a fan-out workflow — never contends.
  private chains = new Map<string, Promise<unknown>>();

  constructor(opts: RuntimeOptions) {
    this.log = opts.log;
    this.snapshots = opts.snapshots;
    this.transport = opts.transport;
    this.timers = opts.timers;
    this.timeoutMode = opts.timeoutMode;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.snapshotEvery = opts.snapshotEvery ?? 64;
  }

  /** Dispatch a request, committing its effects before returning. */
  async apply(now: number, req: Request): Promise<Response> {
    return this.serialize(routingOrigin(req), (origin) => this.applyLocked(origin, now, req));
  }

  /**
   * Republish any committed-but-unflushed messages for an origin.
   *
   * This is the reconciliation path the Go server lacks: a process that dies
   * between commit and publish leaves messages in the log, and any process that
   * later materializes the origin — or sweeps it deliberately — will re-send
   * them. Nothing depends on the original publisher coming back.
   */
  async recover(origin: string): Promise<number> {
    return this.serialize(origin, async (o) => {
      const entry = await this.materialize(o);
      return this.flush(o, entry);
    });
  }

  /**
   * Fire timeouts due at `now` for one origin, committing the result.
   *
   * The tick is an ordinary transition: it goes through the same conditional
   * append as a client request, so a timeout firing concurrently with a request
   * cannot lose either one. Returns the number of changes committed, or 0 when
   * nothing was due — the common case, which costs one materialization and no
   * write.
   */
  async tick(origin: string, now: number): Promise<number> {
    return this.serialize(origin, async (o) => {
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        const entry = await this.materialize(o);
        const changes = entry.server.tick(now);
        if (changes.length === 0) return 0;

        const batch = messagesOf(changes).length > 0 ? [...changes, entry.server.clearOutbox()] : changes;

        // Same discipline as a client request: arm before, relax after.
        const due = entry.server.nextDue();
        if (due !== undefined) await this.timers?.armNoLaterThan(o, due);

        try {
          entry.seq = await this.log.append(o, batch, entry.seq);
        } catch (err) {
          this.cache.delete(o);
          if (err instanceof ConflictError) continue;
          throw err;
        }
        entry.sinceSnapshot += 1;
        await this.timers?.setDeadline(o, due);
        await this.flush(o, entry);
        await this.maybeSnapshot(o, entry);
        return changes.length;
      }
      throw new TooManyConflictsError(o, this.maxAttempts);
    });
  }

  /**
   * Fire due timeouts across every known origin.
   *
   * Ticking is idempotent and guarded by the machine's own state checks, so it
   * is safe for several processes to sweep the same origins concurrently — a
   * redundant tick finds nothing due and commits nothing. That is what removes
   * the need for leader election or ownership: no coordination is required for
   * correctness, only for efficiency.
   */
  async sweep(now: number): Promise<number> {
    let fired = 0;
    for (const origin of await this.log.origins()) {
      fired += await this.tick(origin, now);
    }
    return fired;
  }

  /** Materialized view of an origin, for inspection and tests. */
  async inspect(origin: string): Promise<Server> {
    return this.serialize(origin, async (o) => (await this.materialize(o)).server);
  }

  /** Drop cached machines, forcing the next request to rebuild from durable state. */
  evict(origin?: string): void {
    if (origin === undefined) this.cache.clear();
    else this.cache.delete(origin);
  }

  // -- internals -------------------------------------------------------------

  private async applyLocked(origin: string, now: number, req: Request): Promise<Response> {
    let lastConflict: ConflictError | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const entry = await this.materialize(origin);
      const { response, changes } = entry.server.apply(now, req);

      // Fold the outbox clear into the same batch, so committed state never
      // carries messages the log already holds.
      const batch = messagesOf(changes).length > 0 ? [...changes, entry.server.clearOutbox()] : changes;

      // ARM BEFORE COMMIT. The machine has already applied the transition, so
      // `nextDue` is the deadline the about-to-be-committed state needs. Arming
      // first can only over-approximate — if the append fails, a timer fires for
      // a transition that never happened and `tick` no-ops. Arming *after* would
      // leave a window where committed state has no timer, which is precisely
      // how a lineage goes permanently dark.
      const due = entry.server.nextDue();
      if (due !== undefined) await this.timers?.armNoLaterThan(origin, due);

      let seq: number;
      try {
        seq = await this.log.append(origin, batch, entry.seq);
      } catch (err) {
        // The machine applied a transition that did not commit; it is dirty
        // either way, so discard it before retrying or propagating.
        this.cache.delete(origin);
        if (err instanceof ConflictError) {
          lastConflict = err;
          continue;
        }
        throw err;
      }

      entry.seq = seq;
      entry.sinceSnapshot += 1;
      // RELAX ONLY AFTER COMMIT. Now that the state is durable, the deadline can
      // be moved later or cleared: doing so before the append landed could have
      // discarded the timer protecting state that was still live.
      await this.timers?.setDeadline(origin, due);
      await this.flush(origin, entry);
      await this.maybeSnapshot(origin, entry);
      return response;
    }

    throw Object.assign(new TooManyConflictsError(origin, this.maxAttempts), { cause: lastConflict });
  }

  private async materialize(origin: string): Promise<Materialized> {
    const cached = this.cache.get(origin);
    if (cached) return cached;

    const checkpoint = await this.snapshots?.load(origin);
    const base = checkpoint?.snapshot;
    const from = checkpoint?.seq ?? 0;
    const tail = await this.log.read(origin, from);

    const snap = fold(
      tail.flatMap((e) => e.changes),
      base ? structuredClone(base) : undefined,
    );
    const seq = tail.length > 0 ? tail[tail.length - 1].seq : from;

    const entry: Materialized = {
      server: hydrate(snap, { timeoutMode: this.timeoutMode }),
      seq,
      // A rebuilt machine has no idea what was already published, so it assumes
      // nothing was. Re-publishing is safe; dropping a message is not.
      flushed: from,
      sinceSnapshot: tail.length,
    };
    this.cache.set(origin, entry);
    // A lineage rebuilt from durable state re-asserts its deadline. This is the
    // repair path: if a registration was ever lost, materializing the origin —
    // which any request, tick or recovery does — puts it back.
    const due = entry.server.nextDue();
    if (due !== undefined) await this.timers?.armNoLaterThan(origin, due);
    return entry;
  }

  private async flush(origin: string, entry: Materialized): Promise<number> {
    if (!this.transport || entry.flushed >= entry.seq) return 0;

    const pending = await this.log.read(origin, entry.flushed);
    let sent = 0;
    for (const logEntry of pending) {
      for (const { address, message } of messagesOf(logEntry.changes)) {
        await this.transport.publish(address, message);
        sent += 1;
      }
      // Advance per entry, so a failure mid-batch only replays the entry that
      // failed rather than everything since the cursor.
      entry.flushed = logEntry.seq;
    }
    return sent;
  }

  private async maybeSnapshot(origin: string, entry: Materialized): Promise<void> {
    if (!this.snapshots || entry.sinceSnapshot < this.snapshotEvery) return;
    await this.snapshots.save(origin, snapshot(entry.server), entry.seq);
    // Only trim what the checkpoint covers *and* what has been published;
    // trimming unflushed entries would lose messages that recovery needs.
    await this.log.trim(origin, Math.min(entry.seq, entry.flushed));
    entry.sinceSnapshot = 0;
  }

  /** Run `fn` with exclusive access to `origin` within this process. */
  private serialize<T>(origin: string, fn: (origin: string) => Promise<T>): Promise<T> {
    const prior = this.chains.get(origin) ?? Promise.resolve();
    const next = prior.then(
      () => fn(origin),
      () => fn(origin),
    );
    // Keep the chain alive but never let it reject unhandled; callers observe
    // rejections through the promise returned to them.
    this.chains.set(
      origin,
      next.catch(() => {}),
    );
    return next;
  }
}
