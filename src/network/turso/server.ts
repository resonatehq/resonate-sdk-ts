// =============================================================================
// ORIGIN SERVER
// =============================================================================
//
// The Resonate protocol, executed against one origin database inside one
// transaction. This is the piece that makes the network decentralized: there
// is no server process to send a request to, so every SDK carries the
// transition relation and runs it locally against the workflow's own database.
//
// The implementation follows `resonatehq/resonate-specification`
// (`spec/03-concrete`) rather than the SQL in `resonatehq/resonate`'s
// `persistence_sqlite.rs`. The two have diverged, and where they do the spec
// is the authority. The differences that matter here:
//
//   * PROJECTION, NOT MUTATION. A pending promise past its deadline is
//     *logically* settled; the spec never mutates state to discover that. All
//     guards and all responses consult the projected view (`project`), and the
//     stored row is converged only by the timeout transition. The SQL server
//     instead eagerly settles on read. Projection is what makes a read
//     side-effect free, which in turn is what lets a replica serve reads
//     without pushing.
//
//   * `external`, NOT `resonate:target`, GATES DURABLE TIMEOUTS. A promise is
//     external when it is tagged `resonate:external`, carries a
//     `resonate:target`, or is a timer. Only external promises may be awaited
//     (`register_callback`/`register_listener` answer 422 otherwise) and only
//     they arm a durable timeout — an internal promise's deadline is
//     projection-only, so an obligation recorded against one could never be
//     discharged.
//
//   * `resonate:delay` DEFERS THE FIRST DISPATCH. A targeted promise created
//     with a delay tag still ahead of `now` arms its retry timer at the delay
//     and emits no execute message; the timer's first firing dispatches it.
//
//   * TIMEOUT ALWAYS WINS. Retry and lease timers consult the *projected*
//     promise before acting, so a logically dead task is never redispatched
//     and never returned to circulation.
//
//   * DEFERRED RESUMES. Settlement does not resume awaiters inline; it records
//     a resume obligation per awaiter, drained after the action completes.
//     The drain runs in the same transaction as the settlement that scheduled
//     it — a suspended task has no armed timer, so losing a resume would
//     strand it forever.
//
// One deviation from the spec is imposed by the decentralized topology rather
// than chosen: `promise.register_callback` requires awaiter and awaited to
// share an origin. That is already the rule the Resonate server enforces, and
// here it is load-bearing — a cross-origin callback would span two databases
// and could not be registered in one transaction.

import { CronExpressionParser } from "cron-parser";
import type {
  Message,
  PromiseCreateReq,
  PromiseRecord,
  PromiseSettleReq,
  Request,
  Response,
  ScheduleRecord,
  TaskRecord,
  Value,
} from "../types.js";
import type { TursoExecutor } from "./driver.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default pending-retry interval: how long a dispatched task may go unclaimed. */
export const DEFAULT_RETRY_TIMEOUT = 30_000;

/** The states a client is allowed to settle a promise into. */
const SETTABLE = new Set(["resolved", "rejected", "rejected_canceled"]);

// =============================================================================
// ROW TYPES
// =============================================================================

interface PromiseRow {
  id: string;
  state: PromiseRecord["state"];
  param_headers: string | null;
  param_data: string | null;
  value_headers: string | null;
  value_data: string | null;
  tags: string;
  target: string | null;
  branch: string | null;
  timer: number;
  external: number;
  timeout_at: number;
  created_at: number;
  settled_at: number | null;
}

interface TaskRow {
  id: string;
  state: TaskRecord["state"];
  version: number;
  pid: string | null;
  ttl: number | null;
}

/** A resume obligation: "awaited settled, wake awaiter". */
interface ResumeReq {
  awaited: string;
  awaiter: string;
}

/** A message a transition emitted, waiting to be handed to the client. */
export interface OutgoingMessage {
  address: string;
  message: Message;
}

/** What a handler returns before the network stamps the response head. */
export interface Outcome {
  kind: Response["kind"];
  status: number;
  data: unknown;
}

/** The result of the fence check every acquired-task action shares. */
type FenceResult = { ok: true; task: TaskRow; promise: PromiseRow } | { ok: false; status: number; data: string };

// =============================================================================
// PURE HELPERS
// =============================================================================

/**
 * The origin a promise id belongs to: everything before the first `.`, or the
 * whole id when it has none. This is the server's own rule (see `origin()` in
 * `resonate/src/types.rs`) and it is what partitions the tenant into
 * databases — one per workflow root.
 */
export function originOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * The hash a sharded fleet partitions origins by: 32-bit FNV-1a over the origin
 * string.
 *
 * Every node — and anything routing requests at them — must compute this
 * identically, so it is specified here rather than left to the caller: FNV-1a,
 * 32-bit, offset basis 2166136261, prime 16777619, over the UTF-16 code units
 * of the origin, returned unsigned. The Python SDK's `hash_origin` is the same
 * function.
 */
export function hashOrigin(origin: string): number {
  let hash = 2166136261;
  for (let i = 0; i < origin.length; i++) {
    hash ^= origin.charCodeAt(i);
    // 32-bit FNV prime multiply, via shifts to stay inside int32.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Which node of `count` owns an origin. */
export function ownerOf(origin: string, count: number): number {
  return hashOrigin(origin) % count;
}

/** A deliverable address: an HTTP callback, or a poll address naming a group. */
export function addressValid(address: string): boolean {
  return (
    address.startsWith("http://") ||
    address.startsWith("https://") ||
    (address.startsWith("poll://") && address.includes("@"))
  );
}

/** Total decimal parse; a malformed tag yields `null` rather than throwing. */
function parseDelay(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseTags(raw: string): Record<string, string> {
  try {
    const tags = JSON.parse(raw);
    if (tags === null || typeof tags !== "object" || Array.isArray(tags)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function encodeValue(value: Value | undefined): [string | null, string | null] {
  const headers = value?.headers === undefined ? null : JSON.stringify(value.headers);
  const data = value?.data === undefined ? null : JSON.stringify(value.data);
  return [headers, data];
}

function decodeValue(headers: string | null, data: string | null): Value {
  const value: Value = {};
  if (headers !== null) {
    try {
      value.headers = JSON.parse(headers);
    } catch {
      /* corrupt header blob: treat as absent rather than failing the request */
    }
  }
  if (data !== null) {
    try {
      value.data = JSON.parse(data);
    } catch {
      /* same */
    }
  }
  return value;
}

/** The tag-derived columns, written explicitly because Turso has no generated columns. */
function tagColumns(tags: Record<string, string>): {
  target: string | null;
  branch: string | null;
  timer: number;
  external: number;
} {
  const target = tags["resonate:target"] ?? null;
  const timer = tags["resonate:timer"] === "true" ? 1 : 0;
  const external = tags["resonate:external"] === "true" || target !== null || timer === 1 ? 1 : 0;
  return { target, branch: tags["resonate:branch"] ?? null, timer, external };
}

/**
 * THE PROJECTION. The logical view of a promise at `now`: a pending promise
 * past its deadline is settled — resolved for timers, rejected_timedout
 * otherwise — stamped at the deadline, so the projected record is identical
 * to the one the timeout transition eventually writes.
 */
function project(row: PromiseRow, now: number): PromiseRow {
  if (row.state !== "pending" || now < row.timeout_at) return row;
  return {
    ...row,
    state: row.timer ? "resolved" : "rejected_timedout",
    settled_at: row.timeout_at,
  };
}

/** True when the promise is logically live: pending and not yet past its deadline. */
function live(row: PromiseRow, now: number): boolean {
  return row.state === "pending" && row.timeout_at > now;
}

function toPromiseRecord(row: PromiseRow): PromiseRecord {
  const record: PromiseRecord = {
    id: row.id,
    state: row.state,
    param: decodeValue(row.param_headers, row.param_data),
    value: decodeValue(row.value_headers, row.value_data),
    tags: parseTags(row.tags),
    timeoutAt: row.timeout_at,
    createdAt: row.created_at,
  };
  if (row.settled_at !== null) record.settledAt = row.settled_at;
  return record;
}

function toTaskRecord(row: TaskRow, resumes: number): TaskRecord {
  const record: TaskRecord = { id: row.id, state: row.state, version: row.version, resumes };
  if (row.pid !== null) record.pid = row.pid;
  if (row.ttl !== null) record.ttl = row.ttl;
  return record;
}

/** The projected task record `task.get` serves: fulfilled once its promise is settled. */
function projectTask(row: TaskRow, promise: PromiseRow, now: number): { row: TaskRow; resumes: number } {
  if (live(promise, now)) return { row, resumes: -1 };
  return { row: { ...row, state: "fulfilled", pid: null, ttl: null }, resumes: 0 };
}

function messageKey(address: string, msg: Message): string {
  return msg.kind === "execute" ? msg.data.task.id : `${msg.data.promise.id}:notify:${address}`;
}

// =============================================================================
// ORIGIN SERVER
// =============================================================================

export class OriginServer {
  private readonly deferred: ResumeReq[] = [];
  /** Messages this transaction emitted, keyed for collapse-on-set. */
  private readonly outgoing = new Map<string, OutgoingMessage>();
  /**
   * True when this transaction changed state that a *different* process may
   * need before the current tenure's next boundary: settling an external
   * promise (the public resolve/reject API — the caller holds no lease, so no
   * boundary of theirs will ever push it) or waking a suspended task. Under
   * `pushOn: "boundary"` the network pushes when this is set, regardless of
   * the request kind.
   */
  private syncNeeded = false;

  constructor(
    private readonly tx: TursoExecutor,
    private readonly now: number,
    private readonly retryTimeout: number = DEFAULT_RETRY_TIMEOUT,
  ) {}

  /**
   * Apply one request, then drain the resume obligations it scheduled.
   *
   * The drain is the spec's `step`: settlement records obligations rather than
   * resuming inline, and every action is followed by exactly one drain pass.
   * A resume never settles anything, so one pass always suffices.
   */
  async apply(req: Request): Promise<Outcome> {
    const outcome = await this.dispatch(req);
    await this.drain();
    return outcome;
  }

  private async dispatch(req: Request): Promise<Outcome> {
    switch (req.kind) {
      case "promise.get":
        return this.promiseGet(req.data.id);
      case "promise.create":
        return this.promiseCreate(req);
      case "promise.settle":
        return this.promiseSettle(req);
      case "promise.register_callback":
        return this.promiseRegisterCallback(req.data.awaited, req.data.awaiter);
      case "promise.register_listener":
        return this.promiseRegisterListener(req.data.awaited, req.data.address);
      case "promise.search":
        return this.promiseSearch(req.data.state, req.data.tags, req.data.limit, req.data.cursor);
      case "task.get":
        return this.taskGet(req.data.id);
      case "task.create":
        return this.taskCreate(req.data.pid, req.data.ttl, req.data.action);
      case "task.acquire":
        return this.taskAcquire(req.data.id, req.data.version, req.data.pid, req.data.ttl);
      case "task.release":
        return this.taskRelease(req.data.id, req.data.version);
      case "task.suspend":
        return this.taskSuspend(req.data.id, req.data.version, req.data.actions);
      case "task.halt":
        return this.taskHalt(req.data.id);
      case "task.continue":
        return this.taskContinue(req.data.id);
      case "task.fulfill":
        return this.taskFulfill(req.data.id, req.data.version, req.data.action);
      case "task.fence":
        return this.taskFence(req.data.id, req.data.version, req.data.action);
      case "task.heartbeat":
        return this.taskHeartbeat(req.data.pid, req.data.tasks);
      case "task.search":
        return this.taskSearch(req.data.state, req.data.limit, req.data.cursor);
      default:
        return { kind: req.kind, status: 501, data: "Not implemented" };
    }
  }

  // ===========================================================================
  // PROMISE
  // ===========================================================================

  private async promiseGet(id: string): Promise<Outcome> {
    const row = await this.getPromise(id);
    if (!row) return { kind: "promise.get", status: 404, data: "Promise not found" };
    return {
      kind: "promise.get",
      status: 200,
      data: { promise: toPromiseRecord(project(row, this.now)) },
    };
  }

  private async promiseCreate(req: PromiseCreateReq): Promise<Outcome> {
    const outcome = await this.createPromise(req);
    return { ...outcome, kind: "promise.create" };
  }

  /** The `promise.create` transition, shared with `task.fence`. */
  private async createPromise(req: PromiseCreateReq): Promise<Outcome> {
    const { id, timeoutAt, param, tags } = req.data;

    // Validation precedes the lookup: the server validates on deserialize, so a
    // malformed request is a 400 whether or not the promise happens to exist.
    const invalid = validateCreate(id, timeoutAt, tags ?? {});
    if (invalid) return { kind: "promise.create", status: 400, data: invalid };

    const existing = await this.getPromise(id);
    if (existing) {
      return {
        kind: "promise.create",
        status: 200,
        data: { promise: toPromiseRecord(project(existing, this.now)) },
      };
    }

    const cols = tagColumns(tags ?? {});

    if (timeoutAt > this.now) {
      const row = await this.insertPromise({
        id,
        state: "pending",
        param,
        tags: tags ?? {},
        cols,
        timeoutAt,
        createdAt: this.now,
        settledAt: null,
      });

      // Only external promises arm a durable timeout — an internal promise's
      // deadline is projection-only, and nothing may be awaiting it.
      if (cols.external) await this.setPromiseTimeout(id, timeoutAt);

      if (cols.target !== null) {
        await this.setTask({ id, state: "pending", version: 0, pid: null, ttl: null });

        const delay = parseDelay(tags?.["resonate:delay"]);
        if (delay !== null && delay > this.now) {
          // Deferred dispatch: arm the retry timer at the delay and emit
          // nothing. The timer's first firing is the first dispatch.
          await this.setTaskTimeout(id, 0, delay);
        } else {
          await this.setTaskTimeout(id, 0, this.now + this.retryTimeout);
          this.setMessage(cols.target, {
            kind: "execute",
            head: {},
            data: { task: { id, version: 0 } },
          });
        }
      }

      return { kind: "promise.create", status: 200, data: { promise: toPromiseRecord(row) } };
    }

    // Born settled: created at or after its own deadline.
    const row = await this.insertPromise({
      id,
      state: cols.timer ? "resolved" : "rejected_timedout",
      param,
      tags: tags ?? {},
      cols,
      timeoutAt,
      createdAt: timeoutAt,
      settledAt: timeoutAt,
    });
    if (cols.target !== null) {
      await this.setTask({ id, state: "fulfilled", version: 0, pid: null, ttl: null });
    }
    return { kind: "promise.create", status: 200, data: { promise: toPromiseRecord(row) } };
  }

  private async promiseSettle(req: PromiseSettleReq): Promise<Outcome> {
    const outcome = await this.settlePromise(req);
    return { ...outcome, kind: "promise.settle" };
  }

  /** The `promise.settle` transition, shared with `task.fence`. */
  private async settlePromise(req: PromiseSettleReq): Promise<Outcome> {
    const { id, state, value } = req.data;
    if (!SETTABLE.has(state)) {
      return { kind: "promise.settle", status: 400, data: "Promise cannot be settled into that state" };
    }

    const row = await this.getPromise(id);
    if (!row) return { kind: "promise.settle", status: 404, data: "Promise not found" };

    if (!live(row, this.now)) {
      return {
        kind: "promise.settle",
        status: 200,
        data: { promise: toPromiseRecord(project(row, this.now)) },
      };
    }

    const settled = await this.settle(row, state, value, this.now);
    return { kind: "promise.settle", status: 200, data: { promise: toPromiseRecord(settled) } };
  }

  private async promiseRegisterCallback(awaited: string, awaiter: string): Promise<Outcome> {
    const kind = "promise.register_callback" as const;
    if (awaited === awaiter) {
      return { kind, status: 400, data: "Awaited and awaiter must be different promises" };
    }
    // Imposed by the topology: a cross-origin callback would span databases.
    if (originOf(awaited) !== originOf(awaiter)) {
      return { kind, status: 400, data: "Awaiter and awaited must belong to the same origin" };
    }

    const awaitedRow = await this.getPromise(awaited);
    if (!awaitedRow) return { kind, status: 404, data: "Awaited promise not found" };

    const awaiterRow = await this.getPromise(awaiter);
    if (!awaiterRow) return { kind, status: 422, data: "Awaiter promise not found" };
    if (awaiterRow.target === null) return { kind, status: 422, data: "Awaiter has no address" };
    if (!awaitedRow.external) return { kind, status: 422, data: "Awaited promise is not external" };

    if (live(awaitedRow, this.now) && live(awaiterRow, this.now)) {
      await this.addCallback(awaited, awaiter);
    }

    return { kind, status: 200, data: { promise: toPromiseRecord(project(awaitedRow, this.now)) } };
  }

  private async promiseRegisterListener(awaited: string, address: string): Promise<Outcome> {
    const kind = "promise.register_listener" as const;
    if (!addressValid(address)) return { kind, status: 400, data: "Invalid listener address" };

    const row = await this.getPromise(awaited);
    if (!row) return { kind, status: 404, data: "Promise not found" };
    if (!row.external) return { kind, status: 422, data: "Awaited promise is not external" };

    if (live(row, this.now)) await this.addListener(awaited, address);

    return { kind, status: 200, data: { promise: toPromiseRecord(project(row, this.now)) } };
  }

  /**
   * Search within this origin.
   *
   * A tenant-wide scan is not offered: promises are partitioned across one
   * database per origin, so "every promise" is not a query any single database
   * can answer. The network routes a search carrying a `resonate:origin` tag
   * filter here and answers everything else with 501 rather than returning a
   * partial result that reads like a complete one.
   */
  private async promiseSearch(
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
    cursor: string | undefined,
  ): Promise<Outcome> {
    const size = Math.min(Math.max(limit ?? 100, 1), 1000);
    const where: string[] = [];
    const args: unknown[] = [];

    if (state !== undefined) {
      where.push("state = ?");
      args.push(state);
    }
    if (cursor !== undefined) {
      where.push("id > ?");
      args.push(cursor);
    }
    // Compound SELECTs are not supported inside WHERE subqueries on Turso, so
    // the tag filter is an AND-chain of extractions rather than an EXCEPT.
    for (const [key, value] of Object.entries(tags ?? {})) {
      where.push("json_extract(tags, ?) = ?");
      args.push(`$.${JSON.stringify(key)}`, value);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = (await this.tx.execute(`SELECT * FROM promises ${clause} ORDER BY id ASC LIMIT ?`, [
      ...args,
      size,
    ])) as PromiseRow[];

    const promises = rows.map((row) => toPromiseRecord(project(row, this.now)));
    const data: { promises: PromiseRecord[]; cursor?: string } = { promises };
    if (rows.length === size) data.cursor = rows[rows.length - 1].id;
    return { kind: "promise.search", status: 200, data };
  }

  // ===========================================================================
  // TASK
  // ===========================================================================

  private async taskGet(id: string): Promise<Outcome> {
    const task = await this.getTask(id);
    if (!task) return { kind: "task.get", status: 404, data: "Task not found" };
    const promise = await this.getPromise(id);
    if (!promise) return { kind: "task.get", status: 404, data: "Promise not found" };

    const projected = projectTask(task, promise, this.now);
    const resumes = projected.resumes >= 0 ? projected.resumes : await this.countResumes(id);
    return { kind: "task.get", status: 200, data: { task: toTaskRecord(projected.row, resumes) } };
  }

  private async taskCreate(pid: string, ttl: number, action: PromiseCreateReq): Promise<Outcome> {
    const kind = "task.create" as const;
    const a = action.data;
    if (!a.tags?.["resonate:target"]) {
      return { kind, status: 400, data: "Action must have a resonate:target tag" };
    }
    if (a.tags["resonate:delay"] !== undefined) {
      return { kind, status: 400, data: "Action must not have a resonate:delay tag" };
    }
    if (ttl <= 0) return { kind, status: 400, data: "TTL must be a positive integer" };

    const invalid = validateCreate(a.id, a.timeoutAt, a.tags);
    if (invalid) return { kind, status: 400, data: invalid };

    const existing = await this.getPromise(a.id);

    if (!existing) {
      const cols = tagColumns(a.tags);

      if (a.timeoutAt > this.now) {
        const promise = await this.insertPromise({
          id: a.id,
          state: "pending",
          param: a.param,
          tags: a.tags,
          cols,
          timeoutAt: a.timeoutAt,
          createdAt: this.now,
          settledAt: null,
        });
        await this.setPromiseTimeout(a.id, a.timeoutAt);
        const task: TaskRow = { id: a.id, state: "acquired", version: 1, pid, ttl };
        await this.setTask(task);
        await this.setTaskTimeout(a.id, 1, this.now + ttl);
        return {
          kind,
          status: 200,
          data: {
            task: toTaskRecord(task, 0),
            promise: toPromiseRecord(promise),
            preload: await this.preload(a.id),
          },
        };
      }

      // Born settled — serve the fulfilled pair, arm nothing.
      const promise = await this.insertPromise({
        id: a.id,
        state: cols.timer ? "resolved" : "rejected_timedout",
        param: a.param,
        tags: a.tags,
        cols,
        timeoutAt: a.timeoutAt,
        createdAt: a.timeoutAt,
        settledAt: a.timeoutAt,
      });
      const task: TaskRow = { id: a.id, state: "fulfilled", version: 0, pid: null, ttl: null };
      await this.setTask(task);
      return {
        kind,
        status: 200,
        data: { task: toTaskRecord(task, 0), promise: toPromiseRecord(promise), preload: [] },
      };
    }

    if (existing.target === null) return { kind, status: 422, data: "Promise has no address" };

    const task = await this.getTask(a.id);
    if (!task) return { kind, status: 409, data: "Task not found" };

    // Re-acquisition is gated on the PROJECTED promise: no lease is ever
    // armed on a logically dead task.
    if (!live(existing, this.now)) {
      const fulfilled: TaskRow = { ...task, state: "fulfilled", pid: null, ttl: null };
      return {
        kind,
        status: 200,
        data: {
          task: toTaskRecord(fulfilled, 0),
          promise: toPromiseRecord(project(existing, this.now)),
          preload: await this.preload(a.id),
        },
      };
    }

    if (task.state === "fulfilled") {
      return {
        kind,
        status: 200,
        data: {
          task: toTaskRecord(task, await this.countResumes(a.id)),
          promise: toPromiseRecord(existing),
          preload: await this.preload(a.id),
        },
      };
    }

    if (task.state !== "pending") return { kind, status: 409, data: "Task already exists" };

    const acquired: TaskRow = { ...task, state: "acquired", version: task.version + 1, pid, ttl };
    await this.setTask(acquired);
    await this.clearResumes(a.id);
    await this.delTaskTimeout(a.id);
    await this.setTaskTimeout(a.id, 1, this.now + ttl);
    return {
      kind,
      status: 200,
      data: {
        task: toTaskRecord(acquired, 0),
        promise: toPromiseRecord(existing),
        preload: await this.preload(a.id),
      },
    };
  }

  private async taskAcquire(id: string, version: number, pid: string, ttl: number): Promise<Outcome> {
    const kind = "task.acquire" as const;
    const task = await this.getTask(id);
    if (!task) return { kind, status: 404, data: "Task not found" };
    const promise = await this.getPromise(id);
    if (!promise) return { kind, status: 409, data: "Promise not found" };

    if (task.state !== "pending") return { kind, status: 409, data: "Task not in pending state" };
    if (!live(promise, this.now)) return { kind, status: 409, data: "Task logically fulfilled" };
    if (task.version !== version) return { kind, status: 409, data: "Version mismatch" };

    const acquired: TaskRow = { ...task, state: "acquired", version: task.version + 1, pid, ttl };
    await this.setTask(acquired);
    await this.clearResumes(id);
    await this.delTaskTimeout(id);
    await this.setTaskTimeout(id, 1, this.now + ttl);

    return {
      kind,
      status: 200,
      data: {
        task: toTaskRecord(acquired, 0),
        promise: toPromiseRecord(promise),
        preload: await this.preload(id),
      },
    };
  }

  private async taskRelease(id: string, version: number): Promise<Outcome> {
    const kind = "task.release" as const;
    const guard = await this.fenced(id, version);
    if (!guard.ok) return { kind, status: guard.status, data: guard.data };
    const { task, promise } = guard;

    const released: TaskRow = { ...task, state: "pending", pid: null, ttl: null };
    await this.setTask(released);
    await this.delTaskTimeout(id);
    await this.setTaskTimeout(id, 0, this.now + this.retryTimeout);
    await this.dispatch_(promise, released);

    return { kind, status: 200, data: {} };
  }

  private async taskSuspend(
    id: string,
    version: number,
    actions: { data: { awaited: string; awaiter: string } }[],
  ): Promise<Outcome> {
    const kind = "task.suspend" as const;
    if (actions.length === 0) return { kind, status: 400, data: "Actions list must not be empty" };
    if (actions.some((a) => a.data.awaiter !== id)) {
      return { kind, status: 400, data: "Awaiter must be the suspending task" };
    }
    if (actions.some((a) => a.data.awaited === id)) {
      return { kind, status: 400, data: "Task cannot await its own promise" };
    }
    const awaitedIds = actions.map((a) => a.data.awaited);
    if (new Set(awaitedIds).size !== awaitedIds.length) {
      return { kind, status: 400, data: "Awaited promises must be distinct" };
    }

    const guard = await this.fenced(id, version);
    if (!guard.ok) return { kind, status: guard.status, data: guard.data };
    const { task } = guard;

    // Callbacks are registered only when EVERY awaited promise is still
    // logically pending; one settled awaited resumes the task immediately.
    let settled = false;
    for (const awaited of awaitedIds) {
      const row = await this.getPromise(awaited);
      if (!row) return { kind, status: 422, data: "Awaited promise not found" };
      if (!row.external) return { kind, status: 422, data: "Awaited promise is not external" };
      if (!live(row, this.now)) settled = true;
    }

    if (settled) {
      await this.clearResumes(id);
      return { kind, status: 300, data: { preload: await this.preload(id) } };
    }

    for (const awaited of awaitedIds) await this.addCallback(awaited, id);
    await this.setTask({ ...task, state: "suspended", pid: null, ttl: null });
    await this.clearResumes(id);
    await this.delTaskTimeout(id);

    return { kind, status: 200, data: {} };
  }

  private async taskHalt(id: string): Promise<Outcome> {
    const kind = "task.halt" as const;
    const task = await this.getTask(id);
    if (!task) return { kind, status: 404, data: "Task not found" };
    const promise = await this.getPromise(id);
    if (!promise) return { kind, status: 404, data: "Promise not found" };

    // A task whose promise is logically settled has no circulation left to
    // take it out of; branching on the stored state here would make the
    // stored-vs-projected divergence observable.
    if (!live(promise, this.now)) return { kind, status: 409, data: "Task is fulfilled" };
    if (task.state === "fulfilled") return { kind, status: 409, data: "Task is fulfilled" };
    if (task.state === "halted") return { kind, status: 200, data: {} };

    await this.setTask({ ...task, state: "halted", pid: null, ttl: null });
    await this.delTaskTimeout(id);
    return { kind, status: 200, data: {} };
  }

  private async taskContinue(id: string): Promise<Outcome> {
    const kind = "task.continue" as const;
    const task = await this.getTask(id);
    if (!task) return { kind, status: 404, data: "Task not found" };
    if (task.state !== "halted") return { kind, status: 409, data: "Task is not halted" };
    const promise = await this.getPromise(id);
    if (!promise) return { kind, status: 404, data: "Promise not found" };
    if (!live(promise, this.now)) return { kind, status: 409, data: "Task is fulfilled" };

    const resumed: TaskRow = { ...task, state: "pending" };
    await this.setTask(resumed);
    await this.setTaskTimeout(id, 0, this.now + this.retryTimeout);
    await this.dispatch_(promise, resumed);

    return { kind, status: 200, data: {} };
  }

  private async taskFulfill(id: string, version: number, action: PromiseSettleReq): Promise<Outcome> {
    const kind = "task.fulfill" as const;
    if (action.data.id !== id) return { kind, status: 400, data: "Promise ID must match task ID" };
    if (!SETTABLE.has(action.data.state)) {
      return { kind, status: 400, data: "Promise cannot be settled into that state" };
    }

    const guard = await this.fenced(id, version);
    if (!guard.ok) return { kind, status: guard.status, data: guard.data };
    const { promise } = guard;

    const settled = await this.settle(promise, action.data.state, action.data.value, this.now);
    return { kind, status: 200, data: { promise: toPromiseRecord(settled) } };
  }

  private async taskFence(id: string, version: number, action: PromiseCreateReq | PromiseSettleReq): Promise<Outcome> {
    const kind = "task.fence" as const;
    if (action.data.id === id) {
      return { kind, status: 400, data: "Fenced action must target another promise" };
    }
    // A fenced action lands in the fencing task's own database, so it has to
    // belong to the same origin.
    if (originOf(action.data.id) !== originOf(id)) {
      return { kind, status: 400, data: "Fenced action must belong to the same origin" };
    }

    const guard = await this.fenced(id, version);
    if (!guard.ok) {
      return { kind, status: guard.status, data: guard.status === 404 ? guard.data : "Fence check failed" };
    }

    const inner =
      action.kind === "promise.create" ? await this.createPromise(action) : await this.settlePromise(action);

    return {
      kind,
      status: 200,
      data: {
        action: {
          kind: action.kind,
          head: { corrId: action.head.corrId, status: inner.status, version: action.head.version },
          data: inner.data,
        },
        preload: [],
      },
    };
  }

  private async taskHeartbeat(pid: string, tasks: { id: string; version: number }[]): Promise<Outcome> {
    for (const ref of tasks) {
      const task = await this.getTask(ref.id);
      if (!task || task.state !== "acquired" || task.version !== ref.version || task.pid !== pid) continue;
      const promise = await this.getPromise(ref.id);
      if (!promise || !live(promise, this.now)) continue;

      await this.delTaskTimeout(ref.id);
      await this.setTaskTimeout(ref.id, 1, this.now + (task.ttl ?? 0));
    }
    return { kind: "task.heartbeat", status: 200, data: {} };
  }

  private async taskSearch(
    state: string | undefined,
    limit: number | undefined,
    cursor: string | undefined,
  ): Promise<Outcome> {
    const size = Math.min(Math.max(limit ?? 100, 1), 1000);
    const where: string[] = [];
    const args: unknown[] = [];
    if (state !== undefined) {
      where.push("state = ?");
      args.push(state);
    }
    if (cursor !== undefined) {
      where.push("id > ?");
      args.push(cursor);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = (await this.tx.execute(`SELECT * FROM tasks ${clause} ORDER BY id ASC LIMIT ?`, [
      ...args,
      size,
    ])) as TaskRow[];

    const tasks: TaskRecord[] = [];
    for (const row of rows) tasks.push(toTaskRecord(row, await this.countResumes(row.id)));
    const data: { tasks: TaskRecord[]; cursor?: string } = { tasks };
    if (rows.length === size) data.cursor = rows[rows.length - 1].id;
    return { kind: "task.search", status: 200, data };
  }

  // ===========================================================================
  // TIMEOUTS
  // ===========================================================================
  //
  // Every timeout transition re-checks its own due time before acting: an
  // armed timer means NOT BEFORE, and the machine enforces the contract rather
  // than trusting whoever fired it. That is what makes the tenant-global
  // timeout index safe to treat as a hint.

  /** Settle a promise whose deadline has passed, converging stored to logical state. */
  async onPromiseTimeout(id: string): Promise<void> {
    const row = await this.getPromise(id);
    if (!row || row.state !== "pending" || row.timeout_at > this.now) return;

    const listeners = await this.getListeners(id);
    const callbacks = await this.getCallbacks(id);
    const settledState = row.timer ? "resolved" : "rejected_timedout";

    await this.tx.execute("UPDATE promises SET state = ?, settled_at = ? WHERE id = ?", [
      settledState,
      row.timeout_at,
      id,
    ]);
    await this.tx.execute("DELETE FROM callbacks WHERE awaited_id = ?", [id]);
    await this.tx.execute("DELETE FROM listeners WHERE promise_id = ?", [id]);
    await this.delPromiseTimeout(id);

    const task = await this.getTask(id);
    if (task) {
      await this.setTask({ ...task, state: "fulfilled", pid: null, ttl: null });
      await this.clearResumes(id);
      await this.delTaskTimeout(id);
    }

    const settled: PromiseRow = { ...row, state: settledState, settled_at: row.timeout_at };
    for (const address of listeners) {
      this.setMessage(address, {
        kind: "unblock",
        head: {},
        data: { promise: toPromiseRecord(settled) },
      });
    }
    for (const awaiter of callbacks) this.defer({ awaited: id, awaiter });

    await this.drain();
  }

  /** Redispatch a pending task whose retry interval elapsed. */
  async onTaskRetryTimeout(id: string): Promise<void> {
    const timeout = await this.getTaskTimeout(id, 0);
    if (!timeout || timeout > this.now) return;

    const task = await this.getTask(id);
    if (!task || task.state !== "pending") return;

    const promise = await this.getPromise(id);
    // Timeout always wins: a logically dead task creates no new work — its
    // cleanup belongs to the promise-timeout transition.
    if (!promise || !live(promise, this.now)) return;

    await this.delTaskTimeout(id);
    await this.setTaskTimeout(id, 0, this.now + this.retryTimeout);
    await this.dispatch_(promise, task);
  }

  /** Return an acquired task whose lease expired to circulation. */
  async onTaskLeaseTimeout(id: string): Promise<void> {
    const timeout = await this.getTaskTimeout(id, 1);
    if (!timeout || timeout > this.now) return;

    const task = await this.getTask(id);
    if (!task || task.state !== "acquired") return;

    const promise = await this.getPromise(id);
    // An expired lease on a logically dead task is not returned to
    // circulation — there is no circulation left.
    if (!promise || !live(promise, this.now)) return;

    const released: TaskRow = { ...task, state: "pending", pid: null, ttl: null };
    await this.setTask(released);
    await this.delTaskTimeout(id);
    await this.setTaskTimeout(id, 0, this.now + this.retryTimeout);
    await this.dispatch_(promise, released);
  }

  // ===========================================================================
  // RESUMES
  // ===========================================================================

  private defer(req: ResumeReq): void {
    if (this.deferred.some((d) => d.awaited === req.awaited && d.awaiter === req.awaiter)) return;
    this.deferred.push(req);
  }

  /** Discharge every recorded resume obligation. A resume settles nothing, so one pass suffices. */
  private async drain(): Promise<void> {
    while (this.deferred.length > 0) {
      const req = this.deferred.shift()!;
      await this.onResume(req);
    }
  }

  private async onResume(req: ResumeReq): Promise<void> {
    const task = await this.getTask(req.awaiter);
    if (!task) return;
    const promise = await this.getPromise(req.awaiter);
    if (!promise) return;
    if (this.now >= promise.timeout_at) return; // the awaiter is itself expired

    if (task.state === "suspended") {
      await this.setTask({ ...task, state: "pending" });
      await this.clearResumes(req.awaiter);
      await this.addResume(req.awaiter, req.awaited);
      await this.setTaskTimeout(req.awaiter, 0, this.now + this.retryTimeout);
      await this.dispatch_(promise, task);
      // A suspended task re-entered circulation: any node may claim it, so
      // the state it resumes from must be servable from the remote.
      this.syncNeeded = true;
      return;
    }

    if (task.state === "pending" || task.state === "acquired" || task.state === "halted") {
      // Buffer: the task is already awake, so record the resume for the next
      // time it suspends or continues.
      await this.addResume(req.awaiter, req.awaited);
    }
  }

  // ===========================================================================
  // SHARED TRANSITIONS
  // ===========================================================================

  /**
   * The fence check every acquired-task action shares: the task exists, its
   * promise is logically live, the task is acquired, and the version matches.
   */
  private async fenced(id: string, version: number): Promise<FenceResult> {
    const task = await this.getTask(id);
    if (!task) return { ok: false, status: 404, data: "Task not found" };
    const promise = await this.getPromise(id);
    if (!promise) return { ok: false, status: 409, data: "Promise not found" };
    if (task.state !== "acquired") return { ok: false, status: 409, data: "Task not acquired" };
    if (!live(promise, this.now)) return { ok: false, status: 409, data: "Task not acquired" };
    if (task.version !== version) return { ok: false, status: 409, data: "Version mismatch" };
    return { ok: true, task, promise };
  }

  /**
   * Settle a live promise: write the terminal state, fulfil the task bound to
   * it, notify listeners, and record a resume obligation per awaiter.
   */
  private async settle(
    row: PromiseRow,
    state: PromiseRecord["state"],
    value: Value | undefined,
    settledAt: number,
  ): Promise<PromiseRow> {
    const listeners = await this.getListeners(row.id);
    const callbacks = await this.getCallbacks(row.id);
    const [headers, data] = encodeValue(value);

    // An external promise may be settled by a process holding no lease (the
    // public resolve/reject API); nothing in that caller's future pushes.
    if (row.external) this.syncNeeded = true;

    await this.tx.execute(
      "UPDATE promises SET state = ?, value_headers = ?, value_data = ?, settled_at = ? WHERE id = ?",
      [state, headers, data, settledAt, row.id],
    );
    await this.tx.execute("DELETE FROM callbacks WHERE awaited_id = ?", [row.id]);
    await this.tx.execute("DELETE FROM listeners WHERE promise_id = ?", [row.id]);
    await this.delPromiseTimeout(row.id);

    const task = await this.getTask(row.id);
    if (task) {
      await this.setTask({ ...task, state: "fulfilled", pid: null, ttl: null });
      await this.clearResumes(row.id);
      await this.delTaskTimeout(row.id);
    }

    const settled: PromiseRow = {
      ...row,
      state,
      value_headers: headers,
      value_data: data,
      settled_at: settledAt,
    };

    for (const address of listeners) {
      this.setMessage(address, {
        kind: "unblock",
        head: {},
        data: { promise: toPromiseRecord(settled) },
      });
    }
    for (const awaiter of callbacks) this.defer({ awaited: row.id, awaiter });

    return settled;
  }

  /** Emit the execute message for a task whose promise carries a target. */
  private async dispatch_(promise: PromiseRow, task: TaskRow): Promise<void> {
    if (promise.target === null) return;
    this.setMessage(promise.target, {
      kind: "execute",
      head: {},
      data: { task: { id: task.id, version: task.version } },
    });
  }

  /** Promises sharing this one's `resonate:branch`, so the caller can skip round trips. */
  private async preload(id: string): Promise<PromiseRecord[]> {
    const row = await this.getPromise(id);
    if (!row || row.branch === null) return [];
    const rows = (await this.tx.execute("SELECT * FROM promises WHERE branch = ? AND id != ? ORDER BY id ASC", [
      row.branch,
      id,
    ])) as PromiseRow[];
    return rows.map((r) => toPromiseRecord(project(r, this.now)));
  }

  // ===========================================================================
  // STORAGE
  // ===========================================================================

  private async getPromise(id: string): Promise<PromiseRow | null> {
    const rows = (await this.tx.execute("SELECT * FROM promises WHERE id = ?", [id])) as PromiseRow[];
    return rows[0] ?? null;
  }

  private async insertPromise(p: {
    id: string;
    state: PromiseRecord["state"];
    param: Value | undefined;
    tags: Record<string, string>;
    cols: ReturnType<typeof tagColumns>;
    timeoutAt: number;
    createdAt: number;
    settledAt: number | null;
  }): Promise<PromiseRow> {
    const [headers, data] = encodeValue(p.param);
    const row: PromiseRow = {
      id: p.id,
      state: p.state,
      param_headers: headers,
      param_data: data,
      value_headers: null,
      value_data: null,
      tags: JSON.stringify(p.tags),
      target: p.cols.target,
      branch: p.cols.branch,
      timer: p.cols.timer,
      external: p.cols.external,
      timeout_at: p.timeoutAt,
      created_at: p.createdAt,
      settled_at: p.settledAt,
    };
    await this.tx.execute(
      `INSERT INTO promises
         (id, state, param_headers, param_data, value_headers, value_data, tags,
          target, branch, timer, external, timeout_at, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.state,
        row.param_headers,
        row.param_data,
        row.value_headers,
        row.value_data,
        row.tags,
        row.target,
        row.branch,
        row.timer,
        row.external,
        row.timeout_at,
        row.created_at,
        row.settled_at,
      ],
    );
    return row;
  }

  private async getTask(id: string): Promise<TaskRow | null> {
    const rows = (await this.tx.execute("SELECT * FROM tasks WHERE id = ?", [id])) as TaskRow[];
    return rows[0] ?? null;
  }

  private async setTask(task: TaskRow): Promise<void> {
    await this.tx.execute(
      `INSERT INTO tasks (id, state, version, pid, ttl) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, version = excluded.version,
         pid = excluded.pid, ttl = excluded.ttl`,
      [task.id, task.state, task.version, task.pid, task.ttl],
    );
  }

  private async getCallbacks(awaitedId: string): Promise<string[]> {
    const rows = await this.tx.execute("SELECT awaiter_id FROM callbacks WHERE awaited_id = ? ORDER BY seq ASC", [
      awaitedId,
    ]);
    return rows.map((r) => r.awaiter_id as string);
  }

  private async addCallback(awaitedId: string, awaiterId: string): Promise<void> {
    await this.tx.execute(
      `INSERT INTO callbacks (awaited_id, awaiter_id, seq)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM callbacks))
       ON CONFLICT (awaited_id, awaiter_id) DO NOTHING`,
      [awaitedId, awaiterId],
    );
  }

  private async getListeners(promiseId: string): Promise<string[]> {
    const rows = await this.tx.execute("SELECT address FROM listeners WHERE promise_id = ? ORDER BY seq ASC", [
      promiseId,
    ]);
    return rows.map((r) => r.address as string);
  }

  private async addListener(promiseId: string, address: string): Promise<void> {
    await this.tx.execute(
      `INSERT INTO listeners (promise_id, address, seq)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM listeners))
       ON CONFLICT (promise_id, address) DO NOTHING`,
      [promiseId, address],
    );
  }

  private async countResumes(taskId: string): Promise<number> {
    const rows = await this.tx.execute("SELECT COUNT(*) AS n FROM resumes WHERE task_id = ?", [taskId]);
    return Number(rows[0]?.n ?? 0);
  }

  private async addResume(taskId: string, awaitedId: string): Promise<void> {
    await this.tx.execute(
      `INSERT INTO resumes (task_id, awaited_id, seq)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM resumes))
       ON CONFLICT (task_id, awaited_id) DO NOTHING`,
      [taskId, awaitedId],
    );
  }

  private async clearResumes(taskId: string): Promise<void> {
    await this.tx.execute("DELETE FROM resumes WHERE task_id = ?", [taskId]);
  }

  private async setPromiseTimeout(id: string, timeoutAt: number): Promise<void> {
    await this.tx.execute(
      `INSERT INTO promise_timeouts (id, timeout_at) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET timeout_at = excluded.timeout_at`,
      [id, timeoutAt],
    );
  }

  private async delPromiseTimeout(id: string): Promise<void> {
    await this.tx.execute("DELETE FROM promise_timeouts WHERE id = ?", [id]);
  }

  private async getTaskTimeout(id: string, kind: number): Promise<number | null> {
    const rows = await this.tx.execute("SELECT timeout_at FROM task_timeouts WHERE id = ? AND kind = ?", [id, kind]);
    return rows.length > 0 ? Number(rows[0].timeout_at) : null;
  }

  private async setTaskTimeout(id: string, kind: number, timeoutAt: number): Promise<void> {
    await this.tx.execute(
      `INSERT INTO task_timeouts (id, kind, timeout_at) VALUES (?, ?, ?)
       ON CONFLICT (id, kind) DO UPDATE SET timeout_at = excluded.timeout_at`,
      [id, kind, timeoutAt],
    );
  }

  /** Disarm every timer on a task, matching the spec's `delTaskTimeout`. */
  private async delTaskTimeout(id: string): Promise<void> {
    await this.tx.execute("DELETE FROM task_timeouts WHERE id = ?", [id]);
  }

  /**
   * Record a message the transition emitted, collapsing on the message key: a
   * newer execute for a task supersedes the older one, so the client never sees
   * a stale version.
   *
   * Messages are held in memory for the duration of the transaction and handed
   * to the client once it commits — they are not state, so nothing writes them
   * to a table.
   */
  private setMessage(address: string, msg: Message): void {
    this.outgoing.set(messageKey(address, msg), { address, message: msg });
  }

  /**
   * Take the messages this transaction produced, in emission order.
   *
   * Called by the network *after* the commit: a rolled-back transaction never
   * reaches here, so a message is only ever delivered for a state change that
   * actually landed.
   */
  takeMessages(): OutgoingMessage[] {
    const messages = [...this.outgoing.values()];
    this.outgoing.clear();
    return messages;
  }

  /** Whether this transaction requires a boundary push — see `syncNeeded`. */
  takeSyncNeeded(): boolean {
    const value = this.syncNeeded;
    this.syncNeeded = false;
    return value;
  }
}

// =============================================================================
// SCHEDULES
// =============================================================================
//
// Schedules live in the tenant database: a schedule's promise id is a
// template, so the promises it fires may land in any number of origins, and
// the schedule itself belongs to none of them.

export interface ScheduleRow {
  id: string;
  cron: string;
  promise_id: string;
  promise_timeout: number;
  promise_param_headers: string | null;
  promise_param_data: string | null;
  promise_tags: string;
  created_at: number;
  next_run_at: number;
  last_run_at: number | null;
}

export function toScheduleRecord(row: ScheduleRow): ScheduleRecord {
  const record: ScheduleRecord = {
    id: row.id,
    cron: row.cron,
    promiseId: row.promise_id,
    promiseTimeout: row.promise_timeout,
    promiseParam: decodeValue(row.promise_param_headers, row.promise_param_data),
    promiseTags: parseTags(row.promise_tags),
    createdAt: row.created_at,
    nextRunAt: row.next_run_at,
  };
  if (row.last_run_at !== null) record.lastRunAt = row.last_run_at;
  return record;
}

/** Expand a schedule's promise-id template against one occurrence. */
export function expandPromiseId(template: string, scheduleId: string, timestamp: number): string {
  return template.replaceAll("{{.id}}", scheduleId).replaceAll("{{.timestamp}}", String(timestamp));
}

/**
 * The next cron instant strictly after `after`.
 *
 * Pinned to UTC: a schedule is fired by whichever process sweeps it first, and
 * those processes need not share a timezone. Interpreting the expression in
 * local time would make the same schedule fire at different instants depending
 * on which machine woke up — and would put this SDK at odds with the Python one
 * in a mixed fleet.
 */
export function nextCron(cron: string, after: number): number {
  return CronExpressionParser.parse(cron, { currentDate: new Date(after), tz: "UTC" })
    .next()
    .getTime();
}

/** Every cron instant in `(since, now]`, in order. */
export function cronOccurrences(cron: string, since: number, now: number, cap = 128): number[] {
  const out: number[] = [];
  let cursor = since;
  while (out.length < cap) {
    const next = nextCron(cron, cursor);
    if (next > now) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export class ScheduleStore {
  constructor(
    private readonly tx: TursoExecutor,
    private readonly now: number,
  ) {}

  async get(id: string): Promise<Outcome> {
    const row = await this.row(id);
    if (!row) return { kind: "schedule.get", status: 404, data: "Schedule not found" };
    return { kind: "schedule.get", status: 200, data: { schedule: toScheduleRecord(row) } };
  }

  async create(data: {
    id: string;
    cron: string;
    promiseId: string;
    promiseTimeout: number;
    promiseParam: Value;
    promiseTags: Record<string, string>;
  }): Promise<Outcome> {
    const kind = "schedule.create" as const;
    // Every fired promise needs a routing target, so a schedule without one is
    // rejected up front rather than firing promises nobody will ever run.
    if (!data.promiseTags?.["resonate:target"]) {
      return { kind, status: 400, data: "promiseTags must include a resonate:target tag" };
    }

    const existing = await this.row(data.id);
    if (existing) return { kind, status: 200, data: { schedule: toScheduleRecord(existing) } };

    let nextRunAt: number;
    try {
      nextRunAt = nextCron(data.cron, this.now);
    } catch {
      return { kind, status: 400, data: "Invalid cron expression" };
    }

    const [headers, blob] = encodeValue(data.promiseParam);
    const row: ScheduleRow = {
      id: data.id,
      cron: data.cron,
      promise_id: data.promiseId,
      promise_timeout: data.promiseTimeout,
      promise_param_headers: headers,
      promise_param_data: blob,
      promise_tags: JSON.stringify(data.promiseTags ?? {}),
      created_at: this.now,
      next_run_at: nextRunAt,
      last_run_at: null,
    };
    await this.tx.execute(
      `INSERT INTO schedules (id, cron, promise_id, promise_timeout, promise_param_headers,
         promise_param_data, promise_tags, created_at, next_run_at, last_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.cron,
        row.promise_id,
        row.promise_timeout,
        row.promise_param_headers,
        row.promise_param_data,
        row.promise_tags,
        row.created_at,
        row.next_run_at,
        row.last_run_at,
      ],
    );
    return { kind, status: 200, data: { schedule: toScheduleRecord(row) } };
  }

  async delete(id: string): Promise<Outcome> {
    const row = await this.row(id);
    if (!row) return { kind: "schedule.delete", status: 404, data: "Schedule not found" };
    await this.tx.execute("DELETE FROM schedules WHERE id = ?", [id]);
    return { kind: "schedule.delete", status: 200, data: {} };
  }

  async search(
    tags: Record<string, string> | undefined,
    limit: number | undefined,
    cursor: string | undefined,
  ): Promise<Outcome> {
    const size = Math.min(Math.max(limit ?? 100, 1), 1000);
    const where: string[] = [];
    const args: unknown[] = [];
    if (cursor !== undefined) {
      where.push("id > ?");
      args.push(cursor);
    }
    for (const [key, value] of Object.entries(tags ?? {})) {
      where.push("json_extract(promise_tags, ?) = ?");
      args.push(`$.${JSON.stringify(key)}`, value);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = (await this.tx.execute(`SELECT * FROM schedules ${clause} ORDER BY id ASC LIMIT ?`, [
      ...args,
      size,
    ])) as ScheduleRow[];

    const data: { schedules: ScheduleRecord[]; cursor?: string } = {
      schedules: rows.map(toScheduleRecord),
    };
    if (rows.length === size) data.cursor = rows[rows.length - 1].id;
    return { kind: "schedule.search", status: 200, data };
  }

  /** Schedules whose next run is due at or before `now`. */
  async due(): Promise<ScheduleRow[]> {
    return (await this.tx.execute("SELECT * FROM schedules WHERE next_run_at <= ? ORDER BY id ASC", [
      this.now,
    ])) as ScheduleRow[];
  }

  async advance(id: string, lastRunAt: number, nextRunAt: number): Promise<void> {
    await this.tx.execute("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?", [
      lastRunAt,
      nextRunAt,
      id,
    ]);
  }

  private async row(id: string): Promise<ScheduleRow | null> {
    const rows = (await this.tx.execute("SELECT * FROM schedules WHERE id = ?", [id])) as ScheduleRow[];
    return rows[0] ?? null;
  }
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Create-time validation, mirroring the Resonate server. The prefix rules are
 * not cosmetic here: `resonate:origin` is what selects the database, so an id
 * that does not sit under its own origin would be written to a database that
 * cannot be found again from the id.
 */
export function validateCreate(id: string, timeoutAt: number, tags: Record<string, string>): string | null {
  if (id.length === 0) return "Promise ID is required";
  if (id.includes("\0")) return "Promise ID must not contain null bytes";
  if (!Number.isSafeInteger(timeoutAt) || timeoutAt < 0) return "TimeoutAt must be a non-negative integer";

  const origin = tags["resonate:origin"];
  if (origin !== undefined) {
    if (origin.includes("."))
      return "resonate:origin must not contain '.': re-rooted (detached) lineages are not supported by TursoNetwork — the origin partition cannot represent them";
    if (id !== origin && !id.startsWith(`${origin}.`)) return "Promise ID must be prefixed by resonate:origin";
  }

  const branch = tags["resonate:branch"];
  if (branch !== undefined && id !== branch && !id.startsWith(`${branch}.`)) {
    return "Promise ID must be prefixed by resonate:branch";
  }

  const parent = tags["resonate:parent"];
  if (parent !== undefined && id !== parent && !id.startsWith(`${parent}.`)) {
    return "Promise ID must be prefixed by resonate:parent";
  }

  if (tags["resonate:prefix"]?.includes(".")) return "resonate:prefix must not contain '.'";

  const rawDelay = tags["resonate:delay"];
  if (rawDelay !== undefined) {
    const delay = parseDelay(rawDelay);
    if (delay === null) return "resonate:delay must be a non-negative integer";
    if (delay >= timeoutAt) return "resonate:delay must be less than timeoutAt";
    if (tags["resonate:target"] === undefined) return "resonate:delay requires a resonate:target tag";
  }

  return null;
}
