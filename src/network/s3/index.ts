// =============================================================================
// S3Network
// =============================================================================
//
// A `Network` with no server behind it.
//
// Every other `Network` in this SDK is a transport: it carries a request to a
// Resonate server and carries the response back. This one is not. There is no
// server; the SDK *is* the server, and the durable state lives in two S3
// buckets the SDK reads and writes directly.
//
// The partition is by workflow. Every promise id is prefixed by its origin —
// the root workflow's id, everything before the first `.` — and each origin
// gets its own document, one object under one key in the WORKFLOW bucket.
// That is not an arbitrary sharding key: the protocol already guarantees a
// callback never crosses an origin (`promise.register_callback` refuses), so
// every request touches exactly one workflow's state, and every transition is
// one conditional PUT of one document. A workflow is a unit of consistency,
// and now also the unit of storage and of atomicity. No log, no claim, no
// fencing — concurrency control is the ETag: get, decide, put-if, and on
// conflict re-get and re-decide. A zombie writer is not fenced; its put
// simply fails. S3 Express One Zone is the right bucket class here — the
// conditional-write API is identical, so Express is a bucket choice, not a
// code path.
//
// The TIMEOUT bucket is shared by the fleet. It holds one small document per
// armed wakeup — `t/<YYYY-MM-DDTHH:MM>/o/<origin>` — keyed by minute-precision
// TIME BUCKET, so lexicographic key order is chronological order. A sweeper
// lists the prefix oldest-first and stops at the present; that ordering is
// why this must be a GENERAL PURPOSE bucket (directory buckets list
// unordered). Entries are hints, re-validated against the origin document
// before anything acts; their durability is guarded by the coverage law (see
// `store.ts`). This index is how a process finds work in a workflow it has
// never seen — and it also holds schedules, which belong to no origin.
//
// MESSAGES ARE NOT STORED. When a transition emits an `execute` or `unblock`,
// the message is handed to the local Resonate client as soon as the document
// lands — no outbox, no queue, no routing table. Reaching a *different*
// process goes through time, not through a queue: a dispatched task carries a
// durable retry timer; if nobody claims it, the timer comes due, and
// whichever process sweeps the timeout bucket re-emits the execute and
// delivers it to its own client. Recovery is the timer, which is exactly why
// the timeout bucket is the one thing shared.
//
// The consequence to know: `resonate:target` is advisory here. A message goes
// to whoever did the work, so this network fits a homogeneous fleet, where
// every process registers the same functions.
//
// SHARDING. Unsharded, any node may pick up any workflow — correct under the
// CAS, but a workflow can migrate mid-flight, and a node that finishes a
// workflow is not necessarily the node waiting on it (its unblock is then
// delivered to the wrong process, and the waiter falls back on its own slow
// path). `shard: { index, count }` — "this process is shard 3 of 5" — gives
// every workflow exactly one owner: the node sweeps only wakeups whose origin
// it owns (`hashOrigin(origin) % count === index`), and the caller routes
// requests with the same function (`ownerOf`). One owner means one writer,
// which is also what makes the CAS cheap: the owner's puts never conflict.
// Shards are dynamic in the sense that matters: the hash is a property of the
// origin alone, and entries carry the origin — so resizing the fleet is a
// configuration change (every node restarts with the new count), not a data
// migration. Nothing in either bucket encodes the member count.

import { ConsoleLogger, type Logger } from "../../logger.js";
import { randomUUID } from "../../platform.js";
import { VERSION } from "../../util.js";
import type { Network } from "../network.js";
import type { Message, Request, RequestHead, Response, Value } from "../types.js";
import type { S3Bucket } from "./driver.js";
import {
  cronOccurrences,
  DEFAULT_RETRY_TIMEOUT,
  expandPromiseId,
  nextCron,
  type OriginServer,
  type Outcome,
  type OutgoingMessage,
  originOf,
  type ScheduleDoc,
  toScheduleRecord,
  validateCreate,
} from "./server.js";
import { AmbiguousOutcomeError, minDeadline, S3Store, type SweepEntry } from "./store.js";

export type { OriginDoc, PromiseDoc, TaskDoc } from "./document.js";
export { TIMEOUT_PROMISE, TIMEOUT_SCHEDULE, TIMEOUT_TASK_LEASE, TIMEOUT_TASK_RETRY } from "./document.js";
export type { AwsBucketConfig, PutCondition, PutResult, S3Bucket, S3Object } from "./driver.js";
export { awsBucket, MemoryBucket } from "./driver.js";
export { hashOrigin, originOf, ownerOf } from "./server.js";
export { minuteBucket, originEntryKey, parseEntryKey, scheduleEntryKey, scheduleKey, workflowKey } from "./store.js";

export interface S3NetworkConfig {
  /**
   * The bucket holding one document per workflow. Never listed on the hot
   * path, so an S3 Express One Zone directory bucket fits best — same
   * conditional-write API, single-digit-millisecond latency. A general
   * purpose bucket works identically.
   */
  workflows: S3Bucket;
  /**
   * The bucket holding wakeup entries and schedules — the one thing the
   * whole fleet shares. MUST be a general purpose bucket: the sweeper
   * depends on `ListObjectsV2` returning keys in ascending order, which a
   * directory bucket does not guarantee. Time is the index here, and
   * ordering is the feature.
   */
  timeouts: S3Bucket;
  /** Worker group; a task targets the group (anycast). Default `"default"`. */
  group?: string;
  /** This process's id; a callback or listener targets it (unicast). */
  pid?: string;
  /** How often to sweep due wakeups, in ms. Default 250. */
  tickMs?: number;
  /**
   * How long a dispatched task may go unclaimed before it is redispatched, in
   * ms. Default 30000.
   */
  retryTimeout?: number;
  /** Due wakeup entries swept per tick. Default 100. */
  batchSize?: number;
  /**
   * This node's slice of a sharded fleet: `{ index, count }` with
   * `0 <= index < count` — "this process is shard 3 of 5".
   *
   * Set it and the node sweeps only the wakeups of origins it owns —
   * `hashOrigin(origin) % count === index`. Every node must agree on `count`
   * and on the hash, which is why the hash ships here as `hashOrigin` rather
   * than being left to the caller. The caller is responsible for routing
   * requests to the owning node; use `ownerOf` for that, so routing and
   * sweeping cannot disagree.
   *
   * This is what turns "any node may pick up any workflow" into "each
   * workflow has exactly one owner": a workflow stops migrating between
   * nodes mid-flight, one owner means one writer (so the document CAS almost
   * never conflicts), and the node that finishes a workflow is the node that
   * was waiting on it. Resizing the fleet is a configuration change, not a
   * data migration — the hash depends on the origin alone.
   *
   * Unset (the default) means this node owns everything.
   */
  shard?: { index: number; count: number };
  logger?: Logger;
}

/** The subset of a request that decides which document serves it. */
type Route =
  | { kind: "origin"; origin: string }
  | { kind: "tenant" }
  | { kind: "multi"; origins: string[] }
  | { kind: "invalid"; reason: string }
  | { kind: "unsupported"; reason: string };

export class S3Network implements Network {
  readonly unicast: string;
  readonly anycast: string;

  private readonly store: S3Store;
  private readonly group: string;
  private readonly pid: string;
  private readonly tickMs: number;
  private readonly retryTimeout: number;
  private readonly batchSize: number;
  private readonly shard?: { index: number; count: number };
  private readonly logger: Logger;

  private readonly callbacks: Array<(msg: Message) => void> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private stopped = false;

  constructor(cfg: S3NetworkConfig) {
    this.group = cfg.group ?? "default";
    this.pid = cfg.pid ?? randomUUID().replace(/-/g, "");
    this.tickMs = cfg.tickMs ?? 250;
    this.retryTimeout = cfg.retryTimeout ?? DEFAULT_RETRY_TIMEOUT;
    this.batchSize = cfg.batchSize ?? 100;
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
    this.store = new S3Store({
      workflows: cfg.workflows,
      timeouts: cfg.timeouts,
      retryTimeout: this.retryTimeout,
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
    this.schedule();
    this.logger?.info(
      { component: "network", group: this.group, pid: this.pid, shard: this.shard },
      "s3 network initialized",
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.callbacks.length = 0;
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
    let outcome: Outcome;
    try {
      outcome = await this.apply(req, now);
    } catch (err) {
      // The machine answers every request with exactly one response; when
      // this implementation cannot determine which (an ambiguous write), or
      // cannot serve at all, the faithful answer is no verdict — a 500. The
      // client treats it like any transport failure, and the protocol's
      // retry and lease timers recover.
      this.logger?.warn({ component: "network", kind: req.kind, error: String(err) }, "s3 request answered 500");
      outcome = {
        kind: req.kind,
        status: 500,
        data: err instanceof AmbiguousOutcomeError ? err.message : `internal error: ${String(err)}`,
      };
    }
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

      case "tenant":
        return await this.applySchedule(req, now);

      case "origin":
        return await this.inOrigin(route.origin, now, (server) => server.apply(req), req);

      case "multi": {
        // Only `task.heartbeat` fans out: its task list may span workflows, so
        // it is split into one step per origin. Each is independent — a
        // heartbeat refreshes leases and can partially apply without breaking
        // any invariant.
        if (req.kind !== "task.heartbeat") return { kind: req.kind, status: 501, data: "Not implemented" };
        for (const origin of route.origins) {
          const tasks = req.data.tasks.filter((t) => originOf(t.id) === origin);
          const scoped = { ...req, data: { ...req.data, tasks } };
          await this.inOrigin(origin, now, (server) => server.apply(scoped), scoped);
        }
        return { kind: "task.heartbeat", status: 200, data: {} };
      }
    }
  }

  /**
   * Pick the document that serves a request.
   *
   * Almost everything routes by the origin of the id it names. The exceptions
   * are the ones that are not about a single workflow: schedules are tenant
   * scoped, and the two searches span workflows and so can only be served when
   * the caller narrows them to one origin.
   */
  private route(req: Request): Route {
    const declared = req.head["resonate:origin"];

    // The header may carry a full promise or task id rather than a bare
    // origin — the engine cores stamp it with the task's id — so it is
    // normalized through `originOf` before use. For a request that also
    // names an id, a header that disagrees with that id's origin is refused
    // outright: honoring it would write one workflow's state into another
    // workflow's document, and silently splitting a workflow across two
    // documents is the one thing the partition must never do.
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
        return { kind: "tenant" };

      default:
        return { kind: "unsupported", reason: "Not implemented" };
    }
  }

  // ---------------------------------------------------------------------------
  // EXECUTION
  // ---------------------------------------------------------------------------

  /**
   * Run one step against an origin document and hand the messages it emitted
   * to the client.
   *
   * Delivery happens only after the document has landed — the store discards
   * a conflicted attempt's messages with its document — and is deferred by a
   * turn of the event loop, so a subscriber that reacts by issuing another
   * request cannot re-enter the call that produced its message.
   */
  private async inOrigin<T>(origin: string, now: number, fn: (server: OriginServer) => T, req?: Request): Promise<T> {
    const { value, messages } = await this.store.updateOrigin(origin, now, (server) => fn(server), req);
    this.dispatch(messages);
    return value;
  }

  /**
   * Hand messages to the local Resonate client. This is the whole of message
   * transport: nothing is stored, and nothing is routed anywhere else.
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

  // ---------------------------------------------------------------------------
  // SCHEDULES
  // ---------------------------------------------------------------------------
  //
  // Schedules live in the timeout bucket — one document per schedule plus a
  // wakeup entry for the next run — because a schedule belongs to no origin:
  // its promise id is a template, so the promises it fires may land anywhere.

  private async applySchedule(req: Request, now: number): Promise<Outcome> {
    switch (req.kind) {
      case "schedule.get": {
        const found = await this.store.getSchedule(req.data.id);
        if (!found) return { kind: "schedule.get", status: 404, data: "Schedule not found" };
        return { kind: "schedule.get", status: 200, data: { schedule: toScheduleRecord(found.doc) } };
      }

      case "schedule.create": {
        const kind = "schedule.create" as const;
        const data = req.data;
        // Every fired promise needs a routing target, so a schedule without
        // one is rejected up front rather than firing promises nobody will
        // ever run.
        if (!data.promiseTags?.["resonate:target"]) {
          return { kind, status: 400, data: "promiseTags must include a resonate:target tag" };
        }

        let nextRunAt: number;
        try {
          nextRunAt = nextCron(data.cron, now);
        } catch {
          return { kind, status: 400, data: "Invalid cron expression" };
        }

        const doc: ScheduleDoc = {
          id: data.id,
          cron: data.cron,
          promiseId: data.promiseId,
          promiseTimeout: data.promiseTimeout,
          promiseParam: data.promiseParam as Value | undefined,
          promiseTags: data.promiseTags ?? {},
          createdAt: now,
          nextRunAt,
          lastRunAt: null,
        };
        const stored = await this.store.createSchedule(doc);
        return { kind, status: 200, data: { schedule: toScheduleRecord(stored.doc) } };
      }

      case "schedule.delete": {
        const found = await this.store.getSchedule(req.data.id);
        if (!found) return { kind: "schedule.delete", status: 404, data: "Schedule not found" };
        await this.store.deleteSchedule(req.data.id);
        return { kind: "schedule.delete", status: 200, data: {} };
      }

      case "schedule.search": {
        const size = Math.min(Math.max(req.data.limit ?? 100, 1), 1000);
        const all = (await this.store.listSchedules())
          .filter((s) => {
            if (req.data.cursor !== undefined && s.id <= req.data.cursor) return false;
            for (const [key, value] of Object.entries(req.data.tags ?? {})) {
              if (s.promiseTags[key] !== value) return false;
            }
            return true;
          })
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const page = all.slice(0, size);
        const data: { schedules: ReturnType<typeof toScheduleRecord>[]; cursor?: string } = {
          schedules: page.map(toScheduleRecord),
        };
        if (page.length === size && all.length > size) data.cursor = page[page.length - 1].id;
        return { kind: "schedule.search", status: 200, data };
      }

      default:
        return { kind: req.kind, status: 501, data: "Not implemented" };
    }
  }

  // ---------------------------------------------------------------------------
  // TICK: the sweep
  // ---------------------------------------------------------------------------
  //
  // Messages are not ticked — they go straight to the client when the document
  // that produced them lands. What the tick does is fire due wakeups, and that
  // is also how work reaches a *different* process: an unclaimed task's retry
  // timer is durable and indexed in the timeout bucket, so whichever process
  // sweeps it re-emits the execute and delivers it locally.

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.tickMs);
  }

  private async tick(now = Date.now()): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.store.dueEntries(now, this.shard, this.batchSize);
      for (const entry of due) {
        try {
          if (entry.kind === "origin") await this.sweepOrigin(entry, now);
          else await this.sweepSchedule(entry, now);
        } catch (err) {
          this.logger?.warn({ component: "network", entry: entry.key, error: String(err) }, "s3 wakeup sweep failed");
        }
      }
    } catch (err) {
      if (!this.stopped) {
        this.logger?.warn({ component: "network", error: String(err) }, "s3 tick failed");
      }
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  /**
   * Fire one origin's due timers: run the document tick — promises first,
   * then task timers, each transition re-checking its own due time (NOT
   * BEFORE) — and complete the entry once the tick has landed. Fire then
   * complete, never the reverse: a crash between the two leaves the entry,
   * the next sweep re-fires, and ticks are idempotent by the write law.
   */
  private async sweepOrigin(entry: SweepEntry, now: number): Promise<void> {
    const { value: newMin, messages } = await this.store.updateOrigin(entry.name, now, (server, doc) => {
      server.tick();
      return minDeadline(doc);
    });
    this.dispatch(messages);
    await this.store.completeEntry(entry, newMin);
  }

  /**
   * Fire the promises a due schedule should have created.
   *
   * A schedule and the promises it fires cannot share an atomicity domain —
   * the promises land in whichever origins their expanded ids name. They do
   * not need to: the expanded id is per-occurrence, so re-firing after a
   * crash finds the promise already there and writes nothing, and the
   * schedule is advanced (by CAS) only once every occurrence is in.
   */
  private async sweepSchedule(entry: SweepEntry, now: number): Promise<void> {
    const found = await this.store.getSchedule(entry.name);
    if (!found) {
      // The schedule is gone; its entry is litter.
      await this.store.completeEntry(entry, null);
      return;
    }
    const { doc, etag } = found;

    let occurrences: number[];
    try {
      occurrences = cronOccurrences(doc.cron, doc.lastRunAt ?? doc.nextRunAt - 1, now);
    } catch (err) {
      this.logger?.warn(
        { component: "network", schedule: doc.id, error: String(err) },
        "s3 skipped a schedule with an unparseable cron expression",
      );
      return;
    }
    if (occurrences.length === 0) {
      // Not due yet — a stale entry, unless it is the cover for the next run.
      await this.store.completeEntry(entry, doc.nextRunAt);
      return;
    }

    for (const at of occurrences) {
      const id = expandPromiseId(doc.promiseId, doc.id, at);
      const invalid = validateCreate(id, at + doc.promiseTimeout, doc.promiseTags);
      if (invalid) {
        this.logger?.warn({ component: "network", schedule: doc.id, error: invalid }, "s3 skipped a schedule firing");
        continue;
      }
      const fire: Request = {
        kind: "promise.create",
        head: { corrId: randomUUID(), version: VERSION },
        data: {
          id,
          timeoutAt: at + doc.promiseTimeout,
          param: doc.promiseParam ?? {},
          tags: { ...doc.promiseTags, "resonate:schedule": doc.id },
        },
      };
      await this.inOrigin(originOf(id), at, (server) => server.apply(fire), fire);
    }

    const last = occurrences[occurrences.length - 1];
    const nextRunAt = nextCron(doc.cron, last);
    await this.store.advanceSchedule(doc, etag, last, nextRunAt);
    await this.store.completeEntry(entry, nextRunAt);
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
        // Drive one full sweep at the caller's clock, so a test can advance
        // time without waiting for it.
        await this.tick(req.data.time ?? now);
        return { kind: "debug.tick", status: 200, data: [] };

      case "debug.reset":
        await this.store.reset();
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
        return await this.snap(originOf(origin), now);
      }

      default:
        return { kind: req.kind, status: 501, data: "Not implemented" };
    }
  }

  private async snap(origin: string, now: number): Promise<Outcome> {
    const { value } = await this.store.updateOrigin(origin, now, (server, doc) => {
      const promises = server.apply({
        kind: "promise.search",
        head: { corrId: randomUUID(), version: VERSION },
        data: { limit: 1000 },
      });
      const tasks = server.apply({
        kind: "task.search",
        head: { corrId: randomUUID(), version: VERSION },
        data: { limit: 1000 },
      });
      return {
        promises: (promises.data as { promises: unknown[] }).promises,
        tasks: (tasks.data as { tasks: unknown[] }).tasks,
        promiseTimeouts: [...doc.promiseTimeouts]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((t) => ({ id: t.id, timeout: t.timeoutAt })),
        taskTimeouts: [...doc.taskTimeouts]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((t) => ({ id: t.id, type: t.kind, timeout: t.timeoutAt })),
        callbacks: [...doc.callbacks]
          .sort((a, b) => (a.awaiter === b.awaiter ? (a.awaited < b.awaited ? -1 : 1) : a.awaiter < b.awaiter ? -1 : 1))
          .map((c) => ({ awaiter: c.awaiter, awaited: c.awaited })),
        listeners: [...doc.listeners]
          .sort((a, b) => (a.promise === b.promise ? (a.address < b.address ? -1 : 1) : a.promise < b.promise ? -1 : 1))
          .map((l) => ({ id: l.promise, address: l.address })),
        // Always empty: messages are handed to the client when the document
        // lands and never held, so there is no pending set to snapshot.
        messages: [],
      };
    });
    return { kind: "debug.snap", status: 200, data: value };
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
