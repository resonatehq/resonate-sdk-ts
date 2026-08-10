// =============================================================================
// TursoNetwork
// =============================================================================
//
// A `Network` with no server behind it.
//
// Every other `Network` in this SDK is a transport: it carries a request to a
// Resonate server and carries the response back. This one is not. There is no
// server; the SDK *is* the server, and the durable state lives in Turso
// databases the SDK reads, writes, and syncs directly.
//
// The partition is by workflow. Every promise id is prefixed by its origin —
// the root workflow's id, everything before the first `.` — and each origin
// gets its own database, `<prefix><origin>`. That is not an arbitrary
// sharding key: the protocol already guarantees a callback never crosses an
// origin (`promise.register_callback` refuses), so every request touches
// exactly one workflow's state and is therefore a single-database
// transaction. A workflow is a unit of consistency, and now also a unit of
// storage — which is what makes "one database per workflow" work at all, and
// what makes each one small enough for a process to hold as a local replica.
//
// One database is shared: `<prefix><timeoutDatabase>`, the tenant database.
// It holds what no single workflow owns — the index of armed timers across all
// origins. The timer index is a mirror, republished from the
// origin databases after every commit and re-validated against them before
// use. It is how a process finds work in a workflow it has never seen.
//
// MESSAGES ARE NOT STORED. When a transition emits an `execute` or `unblock`,
// the message is handed to the local Resonate client as soon as the
// transaction commits — no outbox, no queue, no routing table. This is the
// whole of message transport, and it means delivery is in-process: the node
// that ran the transition is the node that gets the message.
//
// Reaching a *different* process therefore goes through time, not through a
// queue. A dispatched task carries a durable retry timer; if nobody claims it,
// the timer comes due, and whichever process sweeps the tenant timeout index
// re-emits the execute and delivers it to its own client. Recovery is the
// timer, which is exactly why the timeout database is the one thing shared.
//
// The consequence to know: `resonate:target` is advisory here. The address is
// recorded on the promise and echoed in the message, but nothing routes by it
// — a message goes to whoever did the work. In a homogeneous fleet, where
// every process registers the same functions, that is what you want. In a
// heterogeneous one, where only some processes can run a given function, this
// network does not deliver work to the right group.
//
// KNOWN LIMITATION, MEASURED. A result computed on one node does not reach the
// node waiting for it. `resonate.run(...)` waits by registering a listener
// carrying its own unicast address; if a timer resumed the workflow elsewhere,
// that node emits the `unblock` and delivers it to itself. Two nodes, one
// migrating workflow: done at +165ms, caller notified at +60004ms. `execute`
// escapes this because a retry timer re-emits it and any node can claim it;
// `unblock` has no equivalent. Multi-node use needs this closed first — either
// by routing messages to their address, or by having a waiter poll the promise
// it is blocked on rather than waiting to be told.
//
// CONCURRENCY. Nodes do not share a disk — each has its own directory, and
// they converge through the remote. That is what `tursoSyncDriver` is for, and
// it is measured: through Turso Cloud, a committed write is visible to another
// replica in ~200ms median, and a workflow abandoned by one node is recovered
// off the tenant index and completed by another. (`tursoLocalDriver`
// additionally cannot be shared *between* processes at all: Turso takes an
// exclusive file lock on open. It is a single-node driver.)
//
// Under contention the protocol holds. Three nodes racing on the same workflows
// with timer-driven migration between them: every workflow completed with the
// right result, no durable step ran on more than one node, and no two nodes
// disagreed on any result. The version fences do their job. What does not hold
// is liveness — see the known limitation above.
//
// Two structural notes. Fleet-wide write traffic concentrates on the tenant
// database, since every origin publishes its timers there; `TursoStore.flush`
// skips the write when an origin's timers have not moved, which removes most of
// it, but the bottleneck remains.
//
// And the fenced actions are real compare-and-swaps — read, compare, write,
// inside one `BEGIN IMMEDIATE` — atomic against whichever database applies
// them. Across nodes that is not enough, and this is the design's open
// question: with embedded replicas each node applies the CAS to its own copy
// and the copies merge afterwards, so two nodes racing one `task.acquire` BOTH
// win — measured 50 times out of 50. `remoteWrites` was supposed to fix it and
// does not (measured equally broken upstream; see `driver.ts`). Until a
// server-side-transaction driver lands, a fleet MUST shard: one writer per
// workflow, `shard` plus `ownerOf`. See turso.md.

import { ConsoleLogger, type Logger } from "../../logger.js";
import { randomUUID } from "../../platform.js";
import { VERSION } from "../../util.js";
import type { Network } from "../network.js";
import type { Message, PromiseRecord, Request, RequestHead, Response, TaskRecord } from "../types.js";
import type { TursoConnection, TursoDriver, TursoExecutor } from "./driver.js";
import {
  DEFAULT_RETRY_TIMEOUT,
  OriginServer,
  type Outcome,
  type OutgoingMessage,
  originOf,
} from "./server.js";
import { TIMEOUT_PROMISE, TIMEOUT_TASK_LEASE, TIMEOUT_TASK_RETRY, TursoStore } from "./store.js";

export type {
  LibsqlDriverConfig,
  TursoConnection,
  TursoDriver,
  TursoExecutor,
  TursoLocalDriverConfig,
  TursoRow,
  TursoSyncDriverConfig,
} from "./driver.js";
export { assertUrlSafeName, databasePath, libsqlDriver, tursoLocalDriver, tursoSyncDriver } from "./driver.js";
export { hashOrigin, originOf, ownerOf } from "./server.js";

export interface TursoNetworkConfig {
  /**
   * Opens databases by name. Use `tursoSyncDriver` for embedded replicas that
   * sync with Turso Cloud, `tursoLocalDriver` for a local-only directory, or
   * supply your own.
   */
  driver: TursoDriver;
  /**
   * Opens the tenant database, if it lives somewhere other than the origins.
   * Defaults to `driver`.
   *
   * The two databases have opposite access patterns, and a deployment may need
   * to honour that. Origin databases are owned — under static sharding exactly
   * one node ever touches a given workflow — whereas the timeout index is
   * written by every node in the fleet, because that is the whole point of it.
   * A driver that is fine for the first can be wrong for the second:
   * `tursoLocalDriver` takes an exclusive file lock on open, so a fleet sharing
   * one directory for its timer index simply fails to start.
   *
   * Splitting them lets each side use what fits — per-node local files for the
   * origins, something genuinely shared (a `file:` libSQL database, or an
   * embedded replica of one remote) for the index.
   */
  timeoutDriver?: TursoDriver;
  /**
   * Prefix for every database name this network creates. An origin database
   * is `<prefix><origin>`; the tenant database is `<prefix><timeoutDatabase>`.
   * Default `"resonate-"`.
   */
  prefix?: string;
  /**
   * Unprefixed name of the tenant-global database holding the timeout index.
   * Default `"timeouts"`.
   */
  timeoutDatabase?: string;
  /** Worker group; a task targets the group (anycast). Default `"default"`. */
  group?: string;
  /** This process's id; a callback or listener targets it (unicast). */
  pid?: string;
  /** How often to sweep due timers, in ms. Default 250. */
  tickMs?: number;
  /**
   * How long a dispatched task may go unclaimed before it is redispatched, in
   * ms. Default 30000.
   */
  retryTimeout?: number;
  /** Origin databases to keep open at once; least-recently-used are closed. Default 64. */
  maxOpenDatabases?: number;
  /** Due timers swept per tick. Default 100. */
  batchSize?: number;
  /**
   * This node's slice of a sharded fleet: `{ index, count }` with
   * `0 <= index < count`.
   *
   * Set it and the node sweeps only the timers of origins it owns —
   * `hashOrigin(origin) % count === index`. Every node must agree on `count`
   * and on the hash, which is why the hash ships here as `hashOrigin` rather
   * than being left to the caller.
   *
   * This is what turns "any node may pick up any workflow" into "each workflow
   * has exactly one owner". That is worth having: a workflow stops migrating
   * between nodes mid-flight, so it stops contending with itself, and one owner
   * means one writer — which is what the protocol's compare-and-swap wants.
   * The caller is responsible for routing requests to the owning node; use
   * `ownerOf` for that, so routing and sweeping agree.
   *
   * Unset (the default) means this node owns everything.
   */
  shard?: { index: number; count: number };
  /**
   * When to upload an origin database to the remote, on drivers that
   * replicate.
   *
   * `"boundary"` (the default) pushes at the points another process could
   * ever need to read from: a task ends its tenure (fulfill, suspend,
   * release, halt), work becomes visible to the fleet (`task.create`, a root
   * or targeted `promise.create`), or the root promise settles. The
   * intermediate durable steps a task records while it holds the lease stay
   * on the local replica — the lease already guarantees one writer, so nobody
   * else can need them before the boundary. The trade: a crash mid-tenure
   * recovers from the last boundary, not the last step.
   *
   * `"request"` pushes after every committed write, the most conservative
   * cadence: recovery loses at most one request, and the remote is never
   * more than one commit behind the tenant index.
   */
  pushOn?: "boundary" | "request";
  logger?: Logger;
}

/** The subset of a request that decides which database serves it. */
type Route =
  | { kind: "origin"; origin: string }
  | { kind: "multi"; origins: string[] }
  | { kind: "invalid"; reason: string }
  | { kind: "unsupported"; reason: string };

export class TursoNetwork implements Network {
  readonly unicast: string;
  readonly anycast: string;

  private readonly store: TursoStore;
  private readonly group: string;
  private readonly pid: string;
  private readonly tickMs: number;
  private readonly retryTimeout: number;
  private readonly batchSize: number;
  private readonly shard?: { index: number; count: number };
  private readonly pushOn: "boundary" | "request";
  /** Whether this node's ORIGIN driver syncs with a remote; see `warnIfUnshardedReplica`. */
  private readonly replicates: boolean;
  private readonly logger: Logger;

  private readonly callbacks: Array<(msg: Message) => void> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  /** The tick currently running, if any, so `stop()` can wait for it. */
  private inflight?: Promise<void>;
  private stopped = false;

  constructor(cfg: TursoNetworkConfig) {
    this.group = cfg.group ?? "default";
    this.pid = cfg.pid ?? randomUUID().replace(/-/g, "");
    this.tickMs = cfg.tickMs ?? 250;
    this.retryTimeout = cfg.retryTimeout ?? DEFAULT_RETRY_TIMEOUT;
    this.batchSize = cfg.batchSize ?? 100;
    this.pushOn = cfg.pushOn ?? "boundary";
    this.replicates = cfg.driver.replicates === true;
    if (cfg.shard) {
      const { index, count } = cfg.shard;
      if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
        throw new Error(`Invalid shard ${index}/${count}: need integers with 0 <= index < count`);
      }
      this.shard = cfg.shard;
    }
    // A silent sweeper is indistinguishable from a fleet with no work to do,
    // so failures must go somewhere by default; pass a Logger to redirect.
    this.logger = cfg.logger ?? new ConsoleLogger("warn");
    this.store = new TursoStore({
      driver: cfg.driver,
      timeoutDriver: cfg.timeoutDriver,
      prefix: cfg.prefix ?? "resonate-",
      timeoutDatabase: cfg.timeoutDatabase ?? "timeouts",
      maxOpenDatabases: cfg.maxOpenDatabases ?? 64,
      logger: this.logger,
    });

    // A task targets the group; a callback or listener targets this process.
    this.unicast = `poll://uni@${this.group}/${this.pid}`;
    this.anycast = `poll://any@${this.group}`;
  }

  match(target: string): string {
    return `poll://any@${target}`;
  }

  // ---------------------------------------------------------------------------
  // LIFECYCLE
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    await this.store.tenant();
    this.warnIfUnshardedReplica();
    this.schedule();
    this.logger.info({ component: "network", group: this.group, pid: this.pid }, "turso network initialized");
  }

  /**
   * Warn when this node replicates but claims every origin.
   *
   * One node owning everything is a perfectly good single-node deployment —
   * hence a warning and not an error. But a *second* node deployed the same
   * way is the arrangement measured to let two nodes both win one
   * `task.acquire`, 50 times out of 50, and the config gives no hint of it:
   * `shard` reads like an optimization.
   */
  private warnIfUnshardedReplica(): void {
    if (this.shard || !this.replicates) return;
    this.logger.warn(
      { component: "network", pid: this.pid },
      "turso network is replicating but unsharded: safe for a single node, but a second node sharing this " +
        "tenant will double-execute fenced actions (measured). Set `shard` and route with `ownerOf` — see turso.md.",
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.callbacks.length = 0;
    // Let a tick already in flight finish before the connections go away.
    // Closing underneath it would kill its open transaction, and — because a
    // sweep loops over origins — the next iteration would reopen databases
    // after the store was closed and write redispatch timers into a network
    // that is nominally stopped. The tick itself checks `stopped` between
    // origins, so this is a short wait, not a drain of the whole sweep.
    await this.inflight?.catch(() => {});
    await this.store.close();
  }

  recv(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }

  // ---------------------------------------------------------------------------
  // SEND
  // ---------------------------------------------------------------------------

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    const now = req.head["resonate:debug_time"] ?? Date.now();
    const outcome = await this.apply(req, now);
    return this.respond(req.kind, req.head, outcome) as Extract<Response, { kind: K }>;
  };

  private async apply(req: Request, now: number): Promise<Outcome> {
    if (req.kind.startsWith("debug.")) return await this.debug(req, now);

    const route = this.route(req);
    switch (route.kind) {
      case "unsupported":
        return { kind: req.kind, status: 501, data: route.reason };

      case "invalid":
        return { kind: req.kind, status: 400, data: route.reason };

      case "origin":
        return await this.inOrigin(route.origin, now, (server) => server.apply(req), this.pushNow(req));

      case "multi": {
        // Only `task.heartbeat` fans out: its task list may span workflows, so
        // it is split into one transaction per origin. Each is independent —
        // a heartbeat refreshes leases and can partially apply without
        // breaking any invariant.
        if (req.kind !== "task.heartbeat") return { kind: req.kind, status: 501, data: "Not implemented" };
        for (const origin of route.origins) {
          const tasks = req.data.tasks.filter((t) => originOf(t.id) === origin);
          await this.inOrigin(
            origin,
            now,
            (server) => server.apply({ ...req, data: { ...req.data, tasks } }),
            this.pushNow(req),
          );
        }
        return { kind: "task.heartbeat", status: 200, data: {} };
      }
    }
  }

  /**
   * Pick the database that serves a request.
   *
   * Everything routes by the origin of the id it names, except the two
   * searches, which span workflows and so can only be served when the caller
   * narrows them to one origin.
   */
  private route(req: Request): Route {
    const declared = req.head["resonate:origin"];

    // The header may carry a full promise or task id rather than a bare
    // origin — the engine cores stamp it with the task's id — so it is
    // normalized through `originOf` before use. For a request that also
    // names an id, a header that disagrees with that id's origin is refused
    // outright: honoring it would write one workflow's state into another
    // workflow's database, and silently splitting a workflow across two
    // databases is the one thing the partition must never do.
    const resolve = (id: string): Route => {
      const origin = originOf(id);
      if (declared !== undefined && originOf(declared) !== origin) {
        return {
          kind: "invalid",
          reason: `resonate:origin ${JSON.stringify(declared)} does not match the origin of id ${JSON.stringify(id)}`,
        };
      }
      return { kind: "origin", origin };
    };

    switch (req.kind) {
      case "promise.get":
      case "promise.create":
      case "promise.settle":
        return resolve(req.data.id);

      case "promise.register_callback":
        return resolve(req.data.awaited);

      case "promise.register_listener":
        return resolve(req.data.awaited);

      case "promise.search": {
        const origin = declared ?? req.data.tags?.["resonate:origin"];
        if (origin === undefined) {
          return {
            kind: "unsupported",
            reason:
              "Tenant-wide promise search is not supported: promises are partitioned by origin. Narrow the search with a resonate:origin tag.",
          };
        }
        return { kind: "origin", origin: originOf(origin) };
      }

      case "task.get":
      case "task.acquire":
      case "task.release":
      case "task.suspend":
      case "task.halt":
      case "task.continue":
      case "task.fulfill":
      case "task.fence":
        return resolve(req.data.id);

      case "task.create":
        return resolve(req.data.action.data.id);

      case "task.heartbeat": {
        // Always fan out by each task's own origin: a declared header cannot
        // be trusted to cover a list that may span workflows.
        const origins = [...new Set(req.data.tasks.map((t) => originOf(t.id)))];
        return { kind: "multi", origins };
      }

      case "task.search": {
        if (declared === undefined) {
          return {
            kind: "unsupported",
            reason:
              "Tenant-wide task search is not supported: tasks are partitioned by origin. Set the resonate:origin request header.",
          };
        }
        return { kind: "origin", origin: originOf(declared) };
      }

      case "schedule.get":
      case "schedule.create":
      case "schedule.delete":
      case "schedule.search":
        return {
          kind: "unsupported",
          reason: "Schedules are not implemented by TursoNetwork.",
        };

      default:
        return { kind: "unsupported", reason: "Not implemented" };
    }
  }

  // ---------------------------------------------------------------------------
  // EXECUTION
  // ---------------------------------------------------------------------------

  /**
   * Run one transaction against an origin database, publish its timers, and
   * hand the messages it emitted to the client.
   *
   * Both follow-ups are outside the transaction. The flush writes a different
   * database, which a transaction cannot span (see `TursoStore.flush`). The
   * delivery must not happen until the state change is durable, and must not
   * happen while this origin's lock is held — a subscriber is free to call
   * back into `send` for the same workflow, and would deadlock against the
   * lock its own message was delivered under.
   */
  private async inOrigin<T>(
    origin: string,
    now: number,
    fn: (server: OriginServer) => Promise<T>,
    pushOrigin = true,
  ): Promise<T> {
    let outgoing: OutgoingMessage[] = [];
    let syncNeeded = false;
    const result = await this.store.withLock(origin, async () => {
      const conn = await this.store.origin(origin);
      const value = await conn.transaction(async (tx) => {
        const server = new OriginServer(tx, now, this.retryTimeout);
        const v = await fn(server);
        // Read inside the transaction, delivered after it commits: a
        // rolled-back transaction throws before reaching the dispatch below,
        // so no message is ever delivered for a state change that did not land.
        outgoing = server.takeMessages();
        syncNeeded = server.takeSyncNeeded();
        return v;
      });
      // The transaction has committed. Its messages describe durable state and
      // are owed to the client whether or not the mirror write lands — the
      // index is eventual by construction, and the next flush on this origin
      // republishes it, whereas a dropped `unblock` has nothing to re-emit it
      // (settlement already deleted the listener rows). So dispatch first,
      // then let the flush failure surface to the caller.
      try {
        await this.store.flush(origin, conn, pushOrigin || syncNeeded);
      } catch (err) {
        this.dispatch(outgoing);
        outgoing = [];
        throw err;
      }
      return value;
    });
    this.dispatch(outgoing);
    return result;
  }

  /**
   * Should this request's flush upload the origin database to the remote?
   *
   * Under `pushOn: "boundary"`, only at the points another process could ever
   * need to read from — see `TursoNetworkConfig.pushOn`. The child creates and
   * settles that record a task's intermediate durable steps stay local until
   * the task's next boundary; the lease guarantees nobody else is writing this
   * workflow in the meantime, and the sweep transitions (which do not come
   * through here) always push.
   */
  private pushNow(req: Request): boolean {
    if (this.pushOn === "request") return true;
    switch (req.kind) {
      case "task.create":
      case "task.fulfill":
      case "task.suspend":
      case "task.release":
      case "task.halt":
      // `task.continue` is release's mirror — a halted task re-enters
      // circulation with a fresh retry timer, outside any lease tenure — so
      // it is a boundary for exactly the reason release is.
      case "task.continue":
        return true;
      case "promise.create":
        return req.data.id === originOf(req.data.id) || req.data.tags?.["resonate:target"] !== undefined;
      case "promise.settle":
        // Root settles are always boundaries; a settle of an external child
        // (the public resolve/reject API) is caught by the server's
        // syncNeeded flag, which sees the promise row's external bit.
        return req.data.id === originOf(req.data.id);
      default:
        return false;
    }
  }

  /**
   * Hand messages to the local Resonate client.
   *
   * Deferred by a turn of the event loop so a subscriber that reacts by
   * issuing another request cannot re-enter the call that produced its
   * message. This is the whole of message transport: nothing is stored, and
   * nothing is routed anywhere else.
   */
  private dispatch(messages: OutgoingMessage[]): void {
    if (messages.length === 0 || this.callbacks.length === 0) return;
    setTimeout(() => {
      if (this.stopped) return;
      for (const { message } of messages) {
        for (const cb of this.callbacks) cb(message);
      }
    }, 0);
  }

  private async inTenant<T>(fn: (tx: TursoExecutor) => Promise<T>): Promise<T> {
    const tenant = await this.store.tenant();
    const result = await tenant.transaction(fn);
    await tenant.push?.();
    return result;
  }

  // ---------------------------------------------------------------------------
  // TICK: timer sweep
  // ---------------------------------------------------------------------------
  //
  // Messages are not ticked — they go straight to the client when the
  // transaction that produced them commits. What the tick does is fire due
  // timers, which is also how work reaches a *different* process: an
  // unclaimed task's retry timer is durable and indexed tenant-wide, so
  // whichever process sweeps it re-emits the execute and delivers it locally.

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.tickMs);
  }

  private async tick(now = Date.now()): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    const run = (async () => {
      try {
        await this.sweepTimeouts(now);
      } catch (err) {
        if (!this.stopped) {
          this.logger.warn({ component: "network", error: String(err) }, "turso tick failed");
        }
      } finally {
        this.ticking = false;
        this.schedule();
      }
    })();
    // Published so `stop()` can wait for it — see there.
    this.inflight = run;
    await run;
  }

  /**
   * Fire every timer the tenant index says is due.
   *
   * The index is a hint. Each transition re-reads its own armed time from the
   * origin database and refuses an early firing, so a stale index entry costs
   * a wasted open and nothing else.
   */
  private async sweepTimeouts(now: number): Promise<void> {
    const tenant = await this.store.tenant();
    await tenant.pull?.();

    // A sharded node takes only its own slice, in SQL, so a crowded index does
    // not fill its batch with timers belonging to someone else.
    const shardFilter = this.shard ? " AND origin_hash % ? = ?" : "";
    const shardArgs = this.shard ? [this.shard.count, this.shard.index] : [];
    const due = await tenant.execute(
      `SELECT origin, id, kind FROM timeouts WHERE timeout_at <= ?${shardFilter} ORDER BY timeout_at ASC LIMIT ?`,
      [now, ...shardArgs, this.batchSize],
    );
    if (due.length === 0) return;

    const byOrigin = new Map<string, { id: string; kind: number }[]>();
    for (const row of due) {
      const origin = row.origin as string;
      const list = byOrigin.get(origin) ?? [];
      list.push({ id: row.id as string, kind: Number(row.kind) });
      byOrigin.set(origin, list);
    }

    for (const [origin, timers] of byOrigin) {
      // Abandon the rest of the batch once stopped: the timers stay due and
      // the next node to sweep picks them up, whereas continuing would race
      // `stop()`'s close and write into a network that is shutting down.
      if (this.stopped) return;
      try {
        await this.inOrigin(origin, now, async (server) => {
          // Promise timeouts first: they settle promises, which fulfils tasks,
          // which makes the task timers below no-ops rather than spurious
          // redispatches of work that is already logically dead.
          for (const t of timers) {
            if (t.kind === TIMEOUT_PROMISE) await server.onPromiseTimeout(t.id);
          }
          for (const t of timers) {
            if (t.kind === TIMEOUT_TASK_RETRY) await server.onTaskRetryTimeout(t.id);
            else if (t.kind === TIMEOUT_TASK_LEASE) await server.onTaskLeaseTimeout(t.id);
          }
        });
      } catch (err) {
        this.logger.warn({ component: "network", origin, error: String(err) }, "turso timeout sweep failed");
      }
    }
  }

  /**
   * Create the promises due schedules should have fired.
   *
   * A schedule lives in the tenant database but the promises it fires belong
   * to whichever origin their expanded id names, so this cannot be one
   * transaction. It does not need to be: the expanded id is per-occurrence, so
   * re-firing after a crash finds the promise already there and writes
   * nothing, and the schedule is advanced only once every occurrence is in.
   */
  // ---------------------------------------------------------------------------
  // DEBUG
  // ---------------------------------------------------------------------------

  private async debug(req: Request, now: number): Promise<Outcome> {
    switch (req.kind) {
      case "debug.start":
      case "debug.stop":
        return { kind: req.kind, status: 200, data: {} };

      case "debug.tick":
        // Drive one full tick at the caller's clock, so a test can advance
        // time without waiting for it.
        await this.tick(req.data.time ?? now);
        return { kind: "debug.tick", status: 200, data: [] };

      case "debug.reset":
        await this.reset();
        return { kind: "debug.reset", status: 200, data: {} };

      case "debug.snap": {
        const origin = req.head["resonate:origin"];
        if (origin === undefined) {
          return {
            kind: "debug.snap",
            status: 501,
            data: "Tenant-wide snapshots are not supported: state is partitioned by origin. Set the resonate:origin request header.",
          };
        }
        return await this.snap(origin, now);
      }

      default:
        return { kind: req.kind, status: 501, data: "Not implemented" };
    }
  }

  /** Empty every database this network has open. Test support only. */
  private async reset(): Promise<void> {
    await this.inTenant(async (tx) => {
      await tx.execute("DELETE FROM timeouts");
    });
    // Origin databases are created on demand and never enumerated, so only the
    // ones this process has open can be cleared. A caller wanting a clean slate
    // across processes should point the driver at a fresh directory or prefix.
    await this.store.discard();
  }

  private async snap(origin: string, now: number): Promise<Outcome> {
    return await this.store.withLock(origin, async () => {
      const conn = await this.store.origin(origin);
      return await conn.transaction(async (tx) => {
        const promises = await new OriginServer(tx, now, this.retryTimeout).apply({
          kind: "promise.search",
          head: { corrId: randomUUID(), version: VERSION },
          data: { limit: 1000 },
        });
        const tasksOutcome = await new OriginServer(tx, now, this.retryTimeout).apply({
          kind: "task.search",
          head: { corrId: randomUUID(), version: VERSION },
          data: { limit: 1000 },
        });
        const promiseTimeouts = await tx.execute("SELECT id, timeout_at FROM promise_timeouts ORDER BY id");
        const taskTimeouts = await tx.execute("SELECT id, kind, timeout_at FROM task_timeouts ORDER BY id");
        const callbacks = await tx.execute(
          "SELECT awaited_id, awaiter_id FROM callbacks ORDER BY awaiter_id, awaited_id",
        );
        const listeners = await tx.execute("SELECT promise_id, address FROM listeners ORDER BY promise_id, address");

        return {
          kind: "debug.snap" as const,
          status: 200,
          data: {
            promises: (promises.data as { promises: PromiseRecord[] }).promises,
            promiseTimeouts: promiseTimeouts.map((r) => ({ id: r.id as string, timeout: Number(r.timeout_at) })),
            callbacks: callbacks.map((r) => ({ awaiter: r.awaiter_id as string, awaited: r.awaited_id as string })),
            listeners: listeners.map((r) => ({ id: r.promise_id as string, address: r.address as string })),
            tasks: (tasksOutcome.data as { tasks: TaskRecord[] }).tasks,
            taskTimeouts: taskTimeouts.map((r) => ({
              id: r.id as string,
              type: Number(r.kind),
              timeout: Number(r.timeout_at),
            })),
            // Always empty: messages are handed to the client on commit and
            // never held, so there is no pending set to snapshot.
            messages: [],
          },
        };
      });
    });
  }

  // ---------------------------------------------------------------------------
  // RESPONSE
  // ---------------------------------------------------------------------------

  private respond(kind: Request["kind"], head: RequestHead, outcome: Outcome): Response {
    return {
      kind,
      head: { corrId: head.corrId, status: outcome.status, version: head.version },
      data: outcome.data,
    } as Response;
  }
}

// Re-exported so callers can reuse the tenant index's encoding when they build
// tooling over these databases.
export { TIMEOUT_PROMISE, TIMEOUT_TASK_LEASE, TIMEOUT_TASK_RETRY };
