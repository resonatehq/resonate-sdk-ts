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
// origins, and schedules. The timer index is a mirror, republished from the
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
// CONCURRENCY — READ THIS BEFORE DEPLOYING A FLEET. Only the single-node
// arrangement is verified. Within one process this works: requests against an
// origin are serialized, workflows run, and a workflow abandoned mid-flight is
// recovered off the timeout index.
//
// Running several nodes has not been made to work. `tursoLocalDriver` cannot
// do it at all — Turso takes an exclusive file lock, so the second process
// cannot even open the database. `libsqlDriver` can share a file across
// processes but stalls part way through a workflow, single node or not.
// `tursoSyncDriver`, where each node holds its own replica and they converge
// through Turso Cloud, is the arrangement this design is actually for and has
// never been run against a real remote.
//
// The design also concentrates fleet-wide write traffic on the tenant
// database, since every origin publishes its timers there. `TursoStore.flush`
// skips the write when an origin's timers are unchanged, which removes most of
// it, but that file remains the one global bottleneck.

import type { Logger } from "../../logger.js";
import { randomUUID } from "../../platform.js";
import { VERSION } from "../../util.js";
import type { Network } from "../network.js";
import type { Message, PromiseRecord, Request, RequestHead, Response, TaskRecord } from "../types.js";
import type { TursoDriver, TursoExecutor } from "./driver.js";
import {
  cronOccurrences,
  DEFAULT_RETRY_TIMEOUT,
  expandPromiseId,
  nextCron,
  OriginServer,
  type Outcome,
  type OutgoingMessage,
  originOf,
  ScheduleStore,
  toScheduleRecord,
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
export { databasePath, libsqlDriver, tursoLocalDriver, tursoSyncDriver } from "./driver.js";
export { originOf } from "./server.js";

export interface TursoNetworkConfig {
  /**
   * Opens databases by name. Use `tursoSyncDriver` for embedded replicas that
   * sync with Turso Cloud, `tursoLocalDriver` for a local-only directory, or
   * supply your own.
   */
  driver: TursoDriver;
  /**
   * Prefix for every database name this network creates. An origin database
   * is `<prefix><origin>`; the tenant database is `<prefix><timeoutDatabase>`.
   * Default `"resonate-"`.
   */
  prefix?: string;
  /**
   * Unprefixed name of the tenant-global database holding the timeout index
   * and schedules. Default `"timeouts"`.
   */
  timeoutDatabase?: string;
  /** Worker group; a task targets the group (anycast). Default `"default"`. */
  group?: string;
  /** This process's id; a callback or listener targets it (unicast). */
  pid?: string;
  /** How often to sweep due timers and schedules, in ms. Default 250. */
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
  logger?: Logger;
}

/** The subset of a request that decides which database serves it. */
type Route =
  | { kind: "origin"; origin: string }
  | { kind: "tenant" }
  | { kind: "multi"; origins: string[] }
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
  private readonly logger?: Logger;

  private readonly callbacks: Array<(msg: Message) => void> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private stopped = false;

  constructor(cfg: TursoNetworkConfig) {
    this.group = cfg.group ?? "default";
    this.pid = cfg.pid ?? randomUUID().replace(/-/g, "");
    this.tickMs = cfg.tickMs ?? 250;
    this.retryTimeout = cfg.retryTimeout ?? DEFAULT_RETRY_TIMEOUT;
    this.batchSize = cfg.batchSize ?? 100;
    this.logger = cfg.logger;
    this.store = new TursoStore({
      driver: cfg.driver,
      prefix: cfg.prefix ?? "resonate-",
      timeoutDatabase: cfg.timeoutDatabase ?? "timeouts",
      maxOpenDatabases: cfg.maxOpenDatabases ?? 64,
      logger: cfg.logger,
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
    this.schedule();
    this.logger?.info({ component: "network", group: this.group, pid: this.pid }, "turso network initialized");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.callbacks.length = 0;
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

      case "tenant":
        return await this.inTenant(async (tx) => {
          const schedules = new ScheduleStore(tx, now);
          switch (req.kind) {
            case "schedule.get":
              return await schedules.get(req.data.id);
            case "schedule.create":
              return await schedules.create(req.data);
            case "schedule.delete":
              return await schedules.delete(req.data.id);
            case "schedule.search":
              return await schedules.search(req.data.tags, req.data.limit, req.data.cursor);
            default:
              return { kind: req.kind, status: 501, data: "Not implemented" };
          }
        });

      case "origin":
        return await this.inOrigin(route.origin, now, (server) => server.apply(req));

      case "multi": {
        // Only `task.heartbeat` fans out: its task list may span workflows, so
        // it is split into one transaction per origin. Each is independent —
        // a heartbeat refreshes leases and can partially apply without
        // breaking any invariant.
        if (req.kind !== "task.heartbeat") return { kind: req.kind, status: 501, data: "Not implemented" };
        for (const origin of route.origins) {
          const tasks = req.data.tasks.filter((t) => originOf(t.id) === origin);
          await this.inOrigin(origin, now, (server) => server.apply({ ...req, data: { ...req.data, tasks } }));
        }
        return { kind: "task.heartbeat", status: 200, data: {} };
      }
    }
  }

  /**
   * Pick the database that serves a request.
   *
   * Almost everything routes by the origin of the id it names. The exceptions
   * are the ones that are not about a single workflow: schedules are tenant
   * scoped, and the two searches span workflows and so can only be served when
   * the caller narrows them to one origin.
   */
  private route(req: Request): Route {
    const declared = req.head["resonate:origin"];

    switch (req.kind) {
      case "promise.get":
      case "promise.create":
      case "promise.settle":
        return { kind: "origin", origin: declared ?? originOf(req.data.id) };

      case "promise.register_callback":
        return { kind: "origin", origin: declared ?? originOf(req.data.awaited) };

      case "promise.register_listener":
        return { kind: "origin", origin: declared ?? originOf(req.data.awaited) };

      case "promise.search": {
        const origin = declared ?? req.data.tags?.["resonate:origin"];
        if (origin === undefined) {
          return {
            kind: "unsupported",
            reason:
              "Tenant-wide promise search is not supported: promises are partitioned by origin. Narrow the search with a resonate:origin tag.",
          };
        }
        return { kind: "origin", origin };
      }

      case "task.get":
      case "task.acquire":
      case "task.release":
      case "task.suspend":
      case "task.halt":
      case "task.continue":
      case "task.fulfill":
      case "task.fence":
        return { kind: "origin", origin: declared ?? originOf(req.data.id) };

      case "task.create":
        return { kind: "origin", origin: declared ?? originOf(req.data.action.data.id) };

      case "task.heartbeat": {
        if (declared !== undefined) return { kind: "origin", origin: declared };
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
        return { kind: "origin", origin: declared };
      }

      case "schedule.get":
      case "schedule.create":
      case "schedule.delete":
      case "schedule.search":
        return { kind: "tenant" };

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
  private async inOrigin<T>(origin: string, now: number, fn: (server: OriginServer) => Promise<T>): Promise<T> {
    let outgoing: OutgoingMessage[] = [];
    const result = await this.store.withLock(origin, async () => {
      const conn = await this.store.origin(origin);
      const value = await conn.transaction(async (tx) => {
        const server = new OriginServer(tx, now, this.retryTimeout);
        const v = await fn(server);
        // Read inside the transaction, delivered after it commits: a
        // rolled-back transaction throws before reaching the dispatch below,
        // so no message is ever delivered for a state change that did not land.
        outgoing = server.takeMessages();
        return v;
      });
      await this.store.flush(origin, conn);
      return value;
    });
    this.dispatch(outgoing);
    return result;
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
  // TICK: timer sweep and schedule firing
  // ---------------------------------------------------------------------------
  //
  // Messages are not ticked — they go straight to the client when the
  // transaction that produced them commits. What the tick does is fire due
  // timers, and that is also how work reaches a *different* process: an
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
    try {
      await this.sweepTimeouts(now);
      await this.fireSchedules(now);
    } catch (err) {
      if (!this.stopped) {
        this.logger?.warn({ component: "network", error: String(err) }, "turso tick failed");
      }
    } finally {
      this.ticking = false;
      this.schedule();
    }
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

    const due = await tenant.execute(
      "SELECT origin, id, kind FROM timeouts WHERE timeout_at <= ? ORDER BY timeout_at ASC LIMIT ?",
      [now, this.batchSize],
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
        this.logger?.warn({ component: "network", origin, error: String(err) }, "turso timeout sweep failed");
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
  private async fireSchedules(now: number): Promise<void> {
    const tenant = await this.store.tenant();
    const due = await new ScheduleStore(tenant, now).due();

    for (const schedule of due) {
      const record = toScheduleRecord(schedule);
      let occurrences: number[];
      try {
        occurrences = cronOccurrences(record.cron, schedule.last_run_at ?? schedule.next_run_at - 1, now);
      } catch (err) {
        this.logger?.warn(
          { component: "network", schedule: schedule.id, error: String(err) },
          "turso skipped a schedule with an unparseable cron expression",
        );
        continue;
      }
      if (occurrences.length === 0) continue;

      for (const at of occurrences) {
        const id = expandPromiseId(record.promiseId, record.id, at);
        await this.inOrigin(originOf(id), at, (server) =>
          server.apply({
            kind: "promise.create",
            head: { corrId: randomUUID(), version: VERSION },
            data: {
              id,
              timeoutAt: at + record.promiseTimeout,
              param: record.promiseParam,
              tags: { ...record.promiseTags, "resonate:schedule": record.id },
            },
          }),
        );
      }

      const last = occurrences[occurrences.length - 1];
      await this.inTenant((tx) => new ScheduleStore(tx, now).advance(schedule.id, last, nextCron(record.cron, last)));
    }
  }

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
      for (const table of ["timeouts", "schedules"]) {
        await tx.execute(`DELETE FROM ${table}`);
      }
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
