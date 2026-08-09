// =============================================================================
// ORIGIN SERVER
// =============================================================================
//
// The Resonate protocol, executed against one workflow document in memory.
// This is the piece that makes the network decentralized: there is no server
// process to send a request to, so every SDK carries the transition relation
// and runs it locally against the workflow's own document.
//
// Handlers here are synchronous and pure over the document: the store loads
// the document, a handler mutates it in place, and the store performs one
// conditional PUT of the result. Concurrency control is entirely the store's
// ETag compare-and-swap — a handler never sees a conflict, it is simply re-run
// against the fresher document (see `S3Store.updateOrigin`).
//
// The implementation follows `resonatehq/resonate-specification`
// (`spec/03-concrete`). The rules that matter here:
//
//   * PROJECTION, NOT MUTATION. A pending promise past its deadline is
//     *logically* settled; nothing mutates state to discover that. All guards
//     and all responses consult the projected view (`project`), and the stored
//     row is converged only by the timeout transition. Projection is what
//     makes a read side-effect free — and a side-effect-free read is a GET
//     with no PUT, which is what keeps steady-state reads cheap on S3.
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
//     The drain runs against the same document in the same step — a suspended
//     task has no armed timer, so losing a resume would strand it forever.
//
// One deviation from the spec is imposed by the topology rather than chosen:
// `promise.register_callback` requires awaiter and awaited to share an origin.
// That is already the rule the Resonate server enforces, and here it is
// load-bearing — awaiter and awaited must live in the same document, so every
// settlement fan-out and callback registration runs inline against it. One
// workflow = one document = one atomicity domain.

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
import { type OriginDoc, type PromiseDoc, TASK_TIMEOUT_LEASE, TASK_TIMEOUT_RETRY, type TaskDoc } from "./document.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default pending-retry interval: how long a dispatched task may go unclaimed. */
export const DEFAULT_RETRY_TIMEOUT = 30_000;

/** The states a client is allowed to settle a promise into. */
const SETTABLE = new Set(["resolved", "rejected", "rejected_canceled"]);

// =============================================================================
// SHARED SHAPES
// =============================================================================

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
type FenceResult = { ok: true; task: TaskDoc; promise: PromiseDoc } | { ok: false; status: number; data: string };

// =============================================================================
// PURE HELPERS
// =============================================================================

/**
 * The origin a promise id belongs to: everything before the first `.`, or the
 * whole id when it has none. This is the server's own rule and it is what
 * partitions the tenant into documents — one per workflow root.
 */
export function originOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(0, dot);
}

/**
 * The hash a sharded fleet partitions origins by: 32-bit FNV-1a over the
 * origin string.
 *
 * Every node — and anything routing requests at them — must compute this
 * identically, so it is specified here rather than left to the caller: FNV-1a,
 * 32-bit, offset basis 2166136261, prime 16777619, over the UTF-16 code units
 * of the origin, returned unsigned. This is the same function the Turso
 * network and the Python SDK's `hash_origin` compute, so a mixed fleet — and
 * the caller routing requests at it — cannot disagree with the sweeper.
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

/** The tag-derived fields, fixed at creation so every read agrees. */
function tagFields(tags: Record<string, string>): {
  target: string | null;
  branch: string | null;
  timer: boolean;
  external: boolean;
} {
  const target = tags["resonate:target"] ?? null;
  const timer = tags["resonate:timer"] === "true";
  const external = tags["resonate:external"] === "true" || target !== null || timer;
  return { target, branch: tags["resonate:branch"] ?? null, timer, external };
}

/**
 * THE PROJECTION. The logical view of a promise at `now`: a pending promise
 * past its deadline is settled — resolved for timers, rejected_timedout
 * otherwise — stamped at the deadline, so the projected record is identical
 * to the one the timeout transition eventually writes.
 */
function project(p: PromiseDoc, now: number): PromiseDoc {
  if (p.state !== "pending" || now < p.timeoutAt) return p;
  return {
    ...p,
    state: p.timer ? "resolved" : "rejected_timedout",
    settledAt: p.timeoutAt,
  };
}

/** True when the promise is logically live: pending and not yet past its deadline. */
function live(p: PromiseDoc, now: number): boolean {
  return p.state === "pending" && p.timeoutAt > now;
}

function toPromiseRecord(p: PromiseDoc): PromiseRecord {
  const record: PromiseRecord = {
    id: p.id,
    state: p.state,
    param: p.param ?? {},
    value: p.value ?? {},
    tags: p.tags,
    timeoutAt: p.timeoutAt,
    createdAt: p.createdAt,
  };
  if (p.settledAt !== null) record.settledAt = p.settledAt;
  return record;
}

function toTaskRecord(task: TaskDoc, resumes: number): TaskRecord {
  const record: TaskRecord = { id: task.id, state: task.state, version: task.version, resumes };
  if (task.pid !== null) record.pid = task.pid;
  if (task.ttl !== null) record.ttl = task.ttl;
  return record;
}

/** The projected task record `task.get` serves: fulfilled once its promise is settled. */
function projectTask(task: TaskDoc, promise: PromiseDoc, now: number): { task: TaskDoc; resumes: number } {
  if (live(promise, now)) return { task, resumes: -1 };
  return { task: { ...task, state: "fulfilled", pid: null, ttl: null }, resumes: 0 };
}

function messageKey(address: string, msg: Message): string {
  return msg.kind === "execute" ? msg.data.task.id : `${msg.data.promise.id}:notify:${address}`;
}

// =============================================================================
// ORIGIN SERVER
// =============================================================================

export class OriginServer {
  private readonly deferred: ResumeReq[] = [];
  /** Messages this step emitted, keyed for collapse-on-set. */
  private readonly outgoing = new Map<string, OutgoingMessage>();

  constructor(
    private readonly doc: OriginDoc,
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
  apply(req: Request): Outcome {
    const outcome = this.dispatch(req);
    this.drain();
    return outcome;
  }

  private dispatch(req: Request): Outcome {
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

  private promiseGet(id: string): Outcome {
    const p = this.getPromise(id);
    if (!p) return { kind: "promise.get", status: 404, data: "Promise not found" };
    return {
      kind: "promise.get",
      status: 200,
      data: { promise: toPromiseRecord(project(p, this.now)) },
    };
  }

  private promiseCreate(req: PromiseCreateReq): Outcome {
    const outcome = this.createPromise(req);
    return { ...outcome, kind: "promise.create" };
  }

  /** The `promise.create` transition, shared with `task.fence`. */
  private createPromise(req: PromiseCreateReq): Outcome {
    const { id, timeoutAt, param, tags } = req.data;

    // Validation precedes the lookup: the server validates on deserialize, so a
    // malformed request is a 400 whether or not the promise happens to exist.
    const invalid = validateCreate(id, timeoutAt, tags ?? {});
    if (invalid) return { kind: "promise.create", status: 400, data: invalid };

    const existing = this.getPromise(id);
    if (existing) {
      return {
        kind: "promise.create",
        status: 200,
        data: { promise: toPromiseRecord(project(existing, this.now)) },
      };
    }

    const fields = tagFields(tags ?? {});

    if (timeoutAt > this.now) {
      const p = this.insertPromise({
        id,
        state: "pending",
        param,
        tags: tags ?? {},
        fields,
        timeoutAt,
        createdAt: this.now,
        settledAt: null,
      });

      // Only external promises arm a durable timeout — an internal promise's
      // deadline is projection-only, and nothing may be awaiting it.
      if (fields.external) this.setPromiseTimeout(id, timeoutAt);

      if (fields.target !== null) {
        this.setTask({ id, state: "pending", version: 0, pid: null, ttl: null });

        const delay = parseDelay(tags?.["resonate:delay"]);
        if (delay !== null && delay > this.now) {
          // Deferred dispatch: arm the retry timer at the delay and emit
          // nothing. The timer's first firing is the first dispatch.
          this.setTaskTimeout(id, TASK_TIMEOUT_RETRY, delay);
        } else {
          this.setTaskTimeout(id, TASK_TIMEOUT_RETRY, this.now + this.retryTimeout);
          this.setMessage(fields.target, {
            kind: "execute",
            head: {},
            data: { task: { id, version: 0 } },
          });
        }
      }

      return { kind: "promise.create", status: 200, data: { promise: toPromiseRecord(p) } };
    }

    // Born settled: created at or after its own deadline.
    const p = this.insertPromise({
      id,
      state: fields.timer ? "resolved" : "rejected_timedout",
      param,
      tags: tags ?? {},
      fields,
      timeoutAt,
      createdAt: timeoutAt,
      settledAt: timeoutAt,
    });
    if (fields.target !== null) {
      this.setTask({ id, state: "fulfilled", version: 0, pid: null, ttl: null });
    }
    return { kind: "promise.create", status: 200, data: { promise: toPromiseRecord(p) } };
  }

  private promiseSettle(req: PromiseSettleReq): Outcome {
    const outcome = this.settlePromise(req);
    return { ...outcome, kind: "promise.settle" };
  }

  /** The `promise.settle` transition, shared with `task.fence`. */
  private settlePromise(req: PromiseSettleReq): Outcome {
    const { id, state, value } = req.data;
    if (!SETTABLE.has(state)) {
      return { kind: "promise.settle", status: 400, data: "Promise cannot be settled into that state" };
    }

    const p = this.getPromise(id);
    if (!p) return { kind: "promise.settle", status: 404, data: "Promise not found" };

    if (!live(p, this.now)) {
      return {
        kind: "promise.settle",
        status: 200,
        data: { promise: toPromiseRecord(project(p, this.now)) },
      };
    }

    const settled = this.settle(p, state, value, this.now);
    return { kind: "promise.settle", status: 200, data: { promise: toPromiseRecord(settled) } };
  }

  private promiseRegisterCallback(awaited: string, awaiter: string): Outcome {
    const kind = "promise.register_callback" as const;
    if (awaited === awaiter) {
      return { kind, status: 400, data: "Awaited and awaiter must be different promises" };
    }
    // Imposed by the topology: a cross-origin callback would span documents.
    if (originOf(awaited) !== originOf(awaiter)) {
      return { kind, status: 400, data: "Awaiter and awaited must belong to the same origin" };
    }

    const awaitedP = this.getPromise(awaited);
    if (!awaitedP) return { kind, status: 404, data: "Awaited promise not found" };

    const awaiterP = this.getPromise(awaiter);
    if (!awaiterP) return { kind, status: 422, data: "Awaiter promise not found" };
    if (awaiterP.target === null) return { kind, status: 422, data: "Awaiter has no address" };
    if (!awaitedP.external) return { kind, status: 422, data: "Awaited promise is not external" };

    if (live(awaitedP, this.now) && live(awaiterP, this.now)) {
      this.addCallback(awaited, awaiter);
    }

    return { kind, status: 200, data: { promise: toPromiseRecord(project(awaitedP, this.now)) } };
  }

  private promiseRegisterListener(awaited: string, address: string): Outcome {
    const kind = "promise.register_listener" as const;
    if (!addressValid(address)) return { kind, status: 400, data: "Invalid listener address" };

    const p = this.getPromise(awaited);
    if (!p) return { kind, status: 404, data: "Promise not found" };
    if (!p.external) return { kind, status: 422, data: "Awaited promise is not external" };

    if (live(p, this.now)) this.addListener(awaited, address);

    return { kind, status: 200, data: { promise: toPromiseRecord(project(p, this.now)) } };
  }

  /**
   * Search within this origin.
   *
   * A tenant-wide scan is not offered: promises are partitioned across one
   * document per origin, so "every promise" is not a query any single document
   * can answer. The network routes a search carrying a `resonate:origin` tag
   * filter here and answers everything else with 501 rather than returning a
   * partial result that reads like a complete one.
   */
  private promiseSearch(
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
    cursor: string | undefined,
  ): Outcome {
    const size = Math.min(Math.max(limit ?? 100, 1), 1000);
    const matches = this.doc.promises
      .filter((p) => {
        if (state !== undefined && p.state !== state) return false;
        if (cursor !== undefined && p.id <= cursor) return false;
        for (const [key, value] of Object.entries(tags ?? {})) {
          if (p.tags[key] !== value) return false;
        }
        return true;
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, size);

    const promises = matches.map((p) => toPromiseRecord(project(p, this.now)));
    const data: { promises: PromiseRecord[]; cursor?: string } = { promises };
    if (matches.length === size) data.cursor = matches[matches.length - 1].id;
    return { kind: "promise.search", status: 200, data };
  }

  // ===========================================================================
  // TASK
  // ===========================================================================

  private taskGet(id: string): Outcome {
    const task = this.getTask(id);
    if (!task) return { kind: "task.get", status: 404, data: "Task not found" };
    const promise = this.getPromise(id);
    if (!promise) return { kind: "task.get", status: 404, data: "Promise not found" };

    const projected = projectTask(task, promise, this.now);
    const resumes = projected.resumes >= 0 ? projected.resumes : this.countResumes(id);
    return { kind: "task.get", status: 200, data: { task: toTaskRecord(projected.task, resumes) } };
  }

  private taskCreate(pid: string, ttl: number, action: PromiseCreateReq): Outcome {
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

    const existing = this.getPromise(a.id);

    if (!existing) {
      const fields = tagFields(a.tags);

      if (a.timeoutAt > this.now) {
        const promise = this.insertPromise({
          id: a.id,
          state: "pending",
          param: a.param,
          tags: a.tags,
          fields,
          timeoutAt: a.timeoutAt,
          createdAt: this.now,
          settledAt: null,
        });
        this.setPromiseTimeout(a.id, a.timeoutAt);
        const task: TaskDoc = { id: a.id, state: "acquired", version: 1, pid, ttl };
        this.setTask(task);
        this.setTaskTimeout(a.id, TASK_TIMEOUT_LEASE, this.now + ttl);
        return {
          kind,
          status: 200,
          data: {
            task: toTaskRecord(task, 0),
            promise: toPromiseRecord(promise),
            preload: this.preload(a.id),
          },
        };
      }

      // Born settled — serve the fulfilled pair, arm nothing.
      const promise = this.insertPromise({
        id: a.id,
        state: fields.timer ? "resolved" : "rejected_timedout",
        param: a.param,
        tags: a.tags,
        fields,
        timeoutAt: a.timeoutAt,
        createdAt: a.timeoutAt,
        settledAt: a.timeoutAt,
      });
      const task: TaskDoc = { id: a.id, state: "fulfilled", version: 0, pid: null, ttl: null };
      this.setTask(task);
      return {
        kind,
        status: 200,
        data: { task: toTaskRecord(task, 0), promise: toPromiseRecord(promise), preload: [] },
      };
    }

    if (existing.target === null) return { kind, status: 422, data: "Promise has no address" };

    const task = this.getTask(a.id);
    if (!task) return { kind, status: 409, data: "Task not found" };

    // Re-acquisition is gated on the PROJECTED promise: no lease is ever
    // armed on a logically dead task.
    if (!live(existing, this.now)) {
      const fulfilled: TaskDoc = { ...task, state: "fulfilled", pid: null, ttl: null };
      return {
        kind,
        status: 200,
        data: {
          task: toTaskRecord(fulfilled, 0),
          promise: toPromiseRecord(project(existing, this.now)),
          preload: this.preload(a.id),
        },
      };
    }

    if (task.state === "fulfilled") {
      return {
        kind,
        status: 200,
        data: {
          task: toTaskRecord(task, this.countResumes(a.id)),
          promise: toPromiseRecord(existing),
          preload: this.preload(a.id),
        },
      };
    }

    if (task.state !== "pending") return { kind, status: 409, data: "Task already exists" };

    const acquired: TaskDoc = { ...task, state: "acquired", version: task.version + 1, pid, ttl };
    this.setTask(acquired);
    this.clearResumes(a.id);
    this.delTaskTimeout(a.id);
    this.setTaskTimeout(a.id, TASK_TIMEOUT_LEASE, this.now + ttl);
    return {
      kind,
      status: 200,
      data: {
        task: toTaskRecord(acquired, 0),
        promise: toPromiseRecord(existing),
        preload: this.preload(a.id),
      },
    };
  }

  private taskAcquire(id: string, version: number, pid: string, ttl: number): Outcome {
    const kind = "task.acquire" as const;
    const task = this.getTask(id);
    if (!task) return { kind, status: 404, data: "Task not found" };
    const promise = this.getPromise(id);
    if (!promise) return { kind, status: 409, data: "Promise not found" };

    if (task.state !== "pending") return { kind, status: 409, data: "Task not in pending state" };
    if (!live(promise, this.now)) return { kind, status: 409, data: "Task logically fulfilled" };
    if (task.version !== version) return { kind, status: 409, data: "Version mismatch" };

    const acquired: TaskDoc = { ...task, state: "acquired", version: task.version + 1, pid, ttl };
    this.setTask(acquired);
    this.clearResumes(id);
    this.delTaskTimeout(id);
    this.setTaskTimeout(id, TASK_TIMEOUT_LEASE, this.now + ttl);

    return {
      kind,
      status: 200,
      data: {
        task: toTaskRecord(acquired, 0),
        promise: toPromiseRecord(promise),
        preload: this.preload(id),
      },
    };
  }

  private taskRelease(id: string, version: number): Outcome {
    const kind = "task.release" as const;
    const guard = this.fenced(id, version);
    if (!guard.ok) return { kind, status: guard.status, data: guard.data };
    const { task, promise } = guard;

    const released: TaskDoc = { ...task, state: "pending", pid: null, ttl: null };
    this.setTask(released);
    this.delTaskTimeout(id);
    this.setTaskTimeout(id, TASK_TIMEOUT_RETRY, this.now + this.retryTimeout);
    this.dispatch_(promise, released);

    return { kind, status: 200, data: {} };
  }

  private taskSuspend(id: string, version: number, actions: { data: { awaited: string; awaiter: string } }[]): Outcome {
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

    const guard = this.fenced(id, version);
    if (!guard.ok) return { kind, status: guard.status, data: guard.data };
    const { task } = guard;

    // Callbacks are registered only when EVERY awaited promise is still
    // logically pending; one settled awaited resumes the task immediately.
    let settled = false;
    for (const awaited of awaitedIds) {
      const p = this.getPromise(awaited);
      if (!p) return { kind, status: 422, data: "Awaited promise not found" };
      if (!p.external) return { kind, status: 422, data: "Awaited promise is not external" };
      if (!live(p, this.now)) settled = true;
    }

    if (settled) {
      this.clearResumes(id);
      return { kind, status: 300, data: { preload: this.preload(id) } };
    }

    for (const awaited of awaitedIds) this.addCallback(awaited, id);
    this.setTask({ ...task, state: "suspended", pid: null, ttl: null });
    this.clearResumes(id);
    this.delTaskTimeout(id);

    return { kind, status: 200, data: {} };
  }

  private taskHalt(id: string): Outcome {
    const kind = "task.halt" as const;
    const task = this.getTask(id);
    if (!task) return { kind, status: 404, data: "Task not found" };
    const promise = this.getPromise(id);
    if (!promise) return { kind, status: 404, data: "Promise not found" };

    // A task whose promise is logically settled has no circulation left to
    // take it out of; branching on the stored state here would make the
    // stored-vs-projected divergence observable.
    if (!live(promise, this.now)) return { kind, status: 409, data: "Task is fulfilled" };
    if (task.state === "fulfilled") return { kind, status: 409, data: "Task is fulfilled" };
    if (task.state === "halted") return { kind, status: 200, data: {} };

    this.setTask({ ...task, state: "halted", pid: null, ttl: null });
    this.delTaskTimeout(id);
    return { kind, status: 200, data: {} };
  }

  private taskContinue(id: string): Outcome {
    const kind = "task.continue" as const;
    const task = this.getTask(id);
    if (!task) return { kind, status: 404, data: "Task not found" };
    if (task.state !== "halted") return { kind, status: 409, data: "Task is not halted" };
    const promise = this.getPromise(id);
    if (!promise) return { kind, status: 404, data: "Promise not found" };
    if (!live(promise, this.now)) return { kind, status: 409, data: "Task is fulfilled" };

    const resumed: TaskDoc = { ...task, state: "pending" };
    this.setTask(resumed);
    this.setTaskTimeout(id, TASK_TIMEOUT_RETRY, this.now + this.retryTimeout);
    this.dispatch_(promise, resumed);

    return { kind, status: 200, data: {} };
  }

  private taskFulfill(id: string, version: number, action: PromiseSettleReq): Outcome {
    const kind = "task.fulfill" as const;
    if (action.data.id !== id) return { kind, status: 400, data: "Promise ID must match task ID" };
    if (!SETTABLE.has(action.data.state)) {
      return { kind, status: 400, data: "Promise cannot be settled into that state" };
    }

    const guard = this.fenced(id, version);
    if (!guard.ok) return { kind, status: guard.status, data: guard.data };
    const { promise } = guard;

    const settled = this.settle(promise, action.data.state, action.data.value, this.now);
    return { kind, status: 200, data: { promise: toPromiseRecord(settled) } };
  }

  private taskFence(id: string, version: number, action: PromiseCreateReq | PromiseSettleReq): Outcome {
    const kind = "task.fence" as const;
    if (action.data.id === id) {
      return { kind, status: 400, data: "Fenced action must target another promise" };
    }
    // A fenced action lands in the fencing task's own document, so it has to
    // belong to the same origin.
    if (originOf(action.data.id) !== originOf(id)) {
      return { kind, status: 400, data: "Fenced action must belong to the same origin" };
    }

    const guard = this.fenced(id, version);
    if (!guard.ok) {
      return { kind, status: guard.status, data: guard.status === 404 ? guard.data : "Fence check failed" };
    }

    const inner = action.kind === "promise.create" ? this.createPromise(action) : this.settlePromise(action);

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

  private taskHeartbeat(pid: string, tasks: { id: string; version: number }[]): Outcome {
    for (const ref of tasks) {
      const task = this.getTask(ref.id);
      if (!task || task.state !== "acquired" || task.version !== ref.version || task.pid !== pid) continue;
      const promise = this.getPromise(ref.id);
      if (!promise || !live(promise, this.now)) continue;

      this.delTaskTimeout(ref.id);
      this.setTaskTimeout(ref.id, TASK_TIMEOUT_LEASE, this.now + (task.ttl ?? 0));
    }
    return { kind: "task.heartbeat", status: 200, data: {} };
  }

  private taskSearch(state: string | undefined, limit: number | undefined, cursor: string | undefined): Outcome {
    const size = Math.min(Math.max(limit ?? 100, 1), 1000);
    const matches = this.doc.tasks
      .filter((t) => {
        if (state !== undefined && t.state !== state) return false;
        if (cursor !== undefined && t.id <= cursor) return false;
        return true;
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, size);

    const tasks = matches.map((t) => toTaskRecord(t, this.countResumes(t.id)));
    const data: { tasks: TaskRecord[]; cursor?: string } = { tasks };
    if (matches.length === size) data.cursor = matches[matches.length - 1].id;
    return { kind: "task.search", status: 200, data };
  }

  // ===========================================================================
  // TIMEOUTS
  // ===========================================================================
  //
  // Every timeout transition re-checks its own due time before acting: an
  // armed timer means NOT BEFORE, and the machine enforces the contract rather
  // than trusting whoever fired it. That is what makes the timeout bucket's
  // entries safe to treat as hints.

  /**
   * Fire every due timer in this document, promises first.
   *
   * Promise timeouts settle promises, which fulfils tasks, which makes the
   * task timers below no-ops rather than spurious redispatches of work that is
   * already logically dead. One pass suffices: no fire arms a timer due at or
   * before `now`.
   */
  tick(): void {
    for (const t of [...this.doc.promiseTimeouts]) {
      if (t.timeoutAt <= this.now) this.onPromiseTimeout(t.id);
    }
    for (const t of [...this.doc.taskTimeouts]) {
      if (t.timeoutAt > this.now) continue;
      if (t.kind === TASK_TIMEOUT_RETRY) this.onTaskRetryTimeout(t.id);
      else this.onTaskLeaseTimeout(t.id);
    }
  }

  /** Settle a promise whose deadline has passed, converging stored to logical state. */
  onPromiseTimeout(id: string): void {
    const p = this.getPromise(id);
    if (!p || p.state !== "pending" || p.timeoutAt > this.now) return;

    const listeners = this.getListeners(id);
    const callbacks = this.getCallbacks(id);
    const settledState = p.timer ? "resolved" : "rejected_timedout";

    p.state = settledState;
    p.settledAt = p.timeoutAt;
    this.doc.callbacks = this.doc.callbacks.filter((c) => c.awaited !== id);
    this.doc.listeners = this.doc.listeners.filter((l) => l.promise !== id);
    this.delPromiseTimeout(id);

    const task = this.getTask(id);
    if (task) {
      this.setTask({ ...task, state: "fulfilled", pid: null, ttl: null });
      this.clearResumes(id);
      this.delTaskTimeout(id);
    }

    for (const address of listeners) {
      this.setMessage(address, {
        kind: "unblock",
        head: {},
        data: { promise: toPromiseRecord(p) },
      });
    }
    for (const awaiter of callbacks) this.defer({ awaited: id, awaiter });

    this.drain();
  }

  /** Redispatch a pending task whose retry interval elapsed. */
  onTaskRetryTimeout(id: string): void {
    const timeout = this.getTaskTimeout(id, TASK_TIMEOUT_RETRY);
    if (timeout === null || timeout > this.now) return;

    const task = this.getTask(id);
    if (!task || task.state !== "pending") return;

    const promise = this.getPromise(id);
    // Timeout always wins: a logically dead task creates no new work — its
    // cleanup belongs to the promise-timeout transition.
    if (!promise || !live(promise, this.now)) return;

    this.delTaskTimeout(id);
    this.setTaskTimeout(id, TASK_TIMEOUT_RETRY, this.now + this.retryTimeout);
    this.dispatch_(promise, task);
  }

  /** Return an acquired task whose lease expired to circulation. */
  onTaskLeaseTimeout(id: string): void {
    const timeout = this.getTaskTimeout(id, TASK_TIMEOUT_LEASE);
    if (timeout === null || timeout > this.now) return;

    const task = this.getTask(id);
    if (!task || task.state !== "acquired") return;

    const promise = this.getPromise(id);
    // An expired lease on a logically dead task is not returned to
    // circulation — there is no circulation left.
    if (!promise || !live(promise, this.now)) return;

    const released: TaskDoc = { ...task, state: "pending", pid: null, ttl: null };
    this.setTask(released);
    this.delTaskTimeout(id);
    this.setTaskTimeout(id, TASK_TIMEOUT_RETRY, this.now + this.retryTimeout);
    this.dispatch_(promise, released);
  }

  // ===========================================================================
  // RESUMES
  // ===========================================================================

  private defer(req: ResumeReq): void {
    if (this.deferred.some((d) => d.awaited === req.awaited && d.awaiter === req.awaiter)) return;
    this.deferred.push(req);
  }

  /** Discharge every recorded resume obligation. A resume settles nothing, so one pass suffices. */
  private drain(): void {
    while (this.deferred.length > 0) {
      const req = this.deferred.shift();
      if (req) this.onResume(req);
    }
  }

  private onResume(req: ResumeReq): void {
    const task = this.getTask(req.awaiter);
    if (!task) return;
    const promise = this.getPromise(req.awaiter);
    if (!promise) return;
    if (this.now >= promise.timeoutAt) return; // the awaiter is itself expired

    if (task.state === "suspended") {
      this.setTask({ ...task, state: "pending" });
      this.clearResumes(req.awaiter);
      this.addResume(req.awaiter, req.awaited);
      this.setTaskTimeout(req.awaiter, TASK_TIMEOUT_RETRY, this.now + this.retryTimeout);
      this.dispatch_(promise, task);
      return;
    }

    if (task.state === "pending" || task.state === "acquired" || task.state === "halted") {
      // Buffer: the task is already awake, so record the resume for the next
      // time it suspends or continues.
      this.addResume(req.awaiter, req.awaited);
    }
  }

  // ===========================================================================
  // SHARED TRANSITIONS
  // ===========================================================================

  /**
   * The fence check every acquired-task action shares: the task exists, its
   * promise is logically live, the task is acquired, and the version matches.
   */
  private fenced(id: string, version: number): FenceResult {
    const task = this.getTask(id);
    if (!task) return { ok: false, status: 404, data: "Task not found" };
    const promise = this.getPromise(id);
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
  private settle(
    p: PromiseDoc,
    state: PromiseRecord["state"],
    value: Value | undefined,
    settledAt: number,
  ): PromiseDoc {
    const listeners = this.getListeners(p.id);
    const callbacks = this.getCallbacks(p.id);

    p.state = state;
    p.value = value;
    p.settledAt = settledAt;
    this.doc.callbacks = this.doc.callbacks.filter((c) => c.awaited !== p.id);
    this.doc.listeners = this.doc.listeners.filter((l) => l.promise !== p.id);
    this.delPromiseTimeout(p.id);

    const task = this.getTask(p.id);
    if (task) {
      this.setTask({ ...task, state: "fulfilled", pid: null, ttl: null });
      this.clearResumes(p.id);
      this.delTaskTimeout(p.id);
    }

    for (const address of listeners) {
      this.setMessage(address, {
        kind: "unblock",
        head: {},
        data: { promise: toPromiseRecord(p) },
      });
    }
    for (const awaiter of callbacks) this.defer({ awaited: p.id, awaiter });

    return p;
  }

  /** Emit the execute message for a task whose promise carries a target. */
  private dispatch_(promise: PromiseDoc, task: TaskDoc): void {
    if (promise.target === null) return;
    this.setMessage(promise.target, {
      kind: "execute",
      head: {},
      data: { task: { id: task.id, version: task.version } },
    });
  }

  /** Promises sharing this one's `resonate:branch`, so the caller can skip round trips. */
  private preload(id: string): PromiseRecord[] {
    const p = this.getPromise(id);
    if (!p || p.branch === null) return [];
    return this.doc.promises
      .filter((other) => other.id !== id && other.branch === p.branch)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((other) => toPromiseRecord(project(other, this.now)));
  }

  // ===========================================================================
  // STORAGE
  // ===========================================================================

  private getPromise(id: string): PromiseDoc | null {
    return this.doc.promises.find((p) => p.id === id) ?? null;
  }

  private insertPromise(p: {
    id: string;
    state: PromiseRecord["state"];
    param: Value | undefined;
    tags: Record<string, string>;
    fields: ReturnType<typeof tagFields>;
    timeoutAt: number;
    createdAt: number;
    settledAt: number | null;
  }): PromiseDoc {
    const row: PromiseDoc = {
      id: p.id,
      state: p.state,
      param: p.param,
      value: undefined,
      tags: p.tags,
      target: p.fields.target,
      branch: p.fields.branch,
      timer: p.fields.timer,
      external: p.fields.external,
      timeoutAt: p.timeoutAt,
      createdAt: p.createdAt,
      settledAt: p.settledAt,
    };
    this.doc.promises.push(row);
    return row;
  }

  private getTask(id: string): TaskDoc | null {
    return this.doc.tasks.find((t) => t.id === id) ?? null;
  }

  private setTask(task: TaskDoc): void {
    const index = this.doc.tasks.findIndex((t) => t.id === task.id);
    if (index === -1) this.doc.tasks.push(task);
    else this.doc.tasks[index] = task;
  }

  private getCallbacks(awaited: string): string[] {
    return this.doc.callbacks.filter((c) => c.awaited === awaited).map((c) => c.awaiter);
  }

  private addCallback(awaited: string, awaiter: string): void {
    if (this.doc.callbacks.some((c) => c.awaited === awaited && c.awaiter === awaiter)) return;
    this.doc.callbacks.push({ awaited, awaiter });
  }

  private getListeners(promise: string): string[] {
    return this.doc.listeners.filter((l) => l.promise === promise).map((l) => l.address);
  }

  private addListener(promise: string, address: string): void {
    if (this.doc.listeners.some((l) => l.promise === promise && l.address === address)) return;
    this.doc.listeners.push({ promise, address });
  }

  private countResumes(task: string): number {
    return this.doc.resumes.filter((r) => r.task === task).length;
  }

  private addResume(task: string, awaited: string): void {
    if (this.doc.resumes.some((r) => r.task === task && r.awaited === awaited)) return;
    this.doc.resumes.push({ task, awaited });
  }

  private clearResumes(task: string): void {
    this.doc.resumes = this.doc.resumes.filter((r) => r.task !== task);
  }

  private setPromiseTimeout(id: string, timeoutAt: number): void {
    const existing = this.doc.promiseTimeouts.find((t) => t.id === id);
    if (existing) existing.timeoutAt = timeoutAt;
    else this.doc.promiseTimeouts.push({ id, timeoutAt });
  }

  private delPromiseTimeout(id: string): void {
    this.doc.promiseTimeouts = this.doc.promiseTimeouts.filter((t) => t.id !== id);
  }

  private getTaskTimeout(id: string, kind: number): number | null {
    return this.doc.taskTimeouts.find((t) => t.id === id && t.kind === kind)?.timeoutAt ?? null;
  }

  private setTaskTimeout(id: string, kind: number, timeoutAt: number): void {
    const existing = this.doc.taskTimeouts.find((t) => t.id === id && t.kind === kind);
    if (existing) existing.timeoutAt = timeoutAt;
    else this.doc.taskTimeouts.push({ id, kind, timeoutAt });
  }

  /** Disarm every timer on a task, matching the spec's `delTaskTimeout`. */
  private delTaskTimeout(id: string): void {
    this.doc.taskTimeouts = this.doc.taskTimeouts.filter((t) => t.id !== id);
  }

  /**
   * Record a message the transition emitted, collapsing on the message key: a
   * newer execute for a task supersedes the older one, so the client never sees
   * a stale version.
   *
   * Messages are held in memory for the duration of the step and handed to the
   * client once the document lands — they are not state, so nothing stores
   * them.
   */
  private setMessage(address: string, msg: Message): void {
    this.outgoing.set(messageKey(address, msg), { address, message: msg });
  }

  /**
   * Take the messages this step produced, in emission order.
   *
   * Called by the store *after* the conditional PUT lands: a conflicted step
   * is re-run against the fresh document and its earlier messages discarded,
   * so a message is only ever delivered for a state change that actually
   * landed.
   */
  takeMessages(): OutgoingMessage[] {
    const messages = [...this.outgoing.values()];
    this.outgoing.clear();
    return messages;
  }
}

// =============================================================================
// AMBIGUITY
// =============================================================================
//
// A conditional PUT can land while its answer is lost. The store then holds
// three kinds of evidence, and a FAITHFUL implementation may act only on
// proof — the specification's machine answers each request with exactly one
// response, so a guessed verdict (re-deciding a landed fence op into a 409,
// or fabricating a 200 from a plausible schedule) is not an implementation
// of the machine at all. The rule: answer truthfully, or do not answer.
//
// `classifyAmbiguousAttempt` renders the verdict for an attempt whose PUT
// reported an unknown outcome and whose bytes are no longer what the store
// holds (byte equality — proof positive — is checked by the store first):
//
//   "landed"    — proof the attempt applied. Report the attempt's own,
//                 already-computed response: it IS the machine's response
//                 for that request at that step.
//   "reapply"   — re-running the request is faithful: either the attempt
//                 provably did not apply (a fresh application is simply the
//                 request happening now), or the operation is response-
//                 idempotent (both worlds yield byte-equal responses, so
//                 re-application cannot misreport either of them).
//   "ambiguous" — the outcome is unknowable. The network answers 500 —
//                 the wire's representation of "no verdict" — and the
//                 protocol's own machinery (retry timers, leases, the
//                 timeout bucket) recovers, exactly as it does for a lost
//                 HTTP response against a real server.
//
// The acquire proof rests on two properties of the machine, verified in the
// specification (`spec/02-abstract`): task versions are MONOTONE (no
// transition decreases one), and only the acquire-shaped transitions bump
// them, each stamping the request's own pid. Hence at most one acquire at
// version v ever applies, and `(acquired, v+1, pid = mine)` is a state
// reachable through MY acquire alone — knowledge, not a guess.

/** The verdict on an attempt whose PUT outcome was unknown and whose bytes have moved. */
export type AmbiguityVerdict = "landed" | "reapply" | "ambiguous";

/**
 * Operations whose re-application provably answers what the landed
 * application answered (create/settle serve the stored record either way;
 * registrations and heartbeats are absorbing; reads never write at all).
 */
const REAPPLY_SAFE = new Set<Request["kind"]>([
  "promise.get",
  "promise.search",
  "task.get",
  "task.search",
  "promise.create",
  "promise.settle",
  "promise.register_callback",
  "promise.register_listener",
  "task.heartbeat",
]);

export function classifyAmbiguousAttempt(
  req: Request,
  before: OriginDoc,
  attempt: OriginDoc,
  fresh: OriginDoc,
): AmbiguityVerdict {
  if (REAPPLY_SAFE.has(req.kind)) return "reapply";

  const id =
    req.kind === "task.create"
      ? req.data.action.data.id
      : "id" in req.data
        ? (req.data as { id: string }).id
        : undefined;
  if (id === undefined) return "ambiguous";

  const task = (doc: OriginDoc) => doc.tasks.find((t) => t.id === id) ?? null;
  const same = (x: TaskDoc | null, y: TaskDoc | null) => JSON.stringify(x) === JSON.stringify(y);
  const b = task(before);
  const a = task(attempt);
  const f = task(fresh);

  switch (req.kind) {
    case "task.acquire":
    case "task.create": {
      // The born-settled create writes a fulfilled task and answers the
      // stored pair — response-idempotent like promise.create.
      if (!a || a.state !== "acquired") return "reapply";
      // Proof of landing: only my acquire at this version, with my pid,
      // reaches this exact task (monotone versions, unique producer).
      if (f && f.state === "acquired" && f.version === a.version && f.pid === a.pid) return "landed";
      // Proof of not landing: the task is untouched, or the one acquire at
      // this version went to a rival — mine cannot also have applied.
      if (same(b, f)) return "reapply";
      if (f && f.state === "acquired" && f.version === a.version && f.pid !== a.pid) return "reapply";
      return "ambiguous";
    }

    case "task.release":
    case "task.suspend":
    case "task.fulfill":
    case "task.halt":
    case "task.continue":
      // These transitions all mutate the task, so an untouched task proves
      // the attempt did not apply. Anything else is unattributable — the
      // post-states erase the writer's identity (release nulls the pid,
      // and a lease expiry produces the same shape).
      return same(b, f) ? "reapply" : "ambiguous";

    case "task.fence":
      // A fence never mutates its own task. With the guard's inputs
      // untouched, re-application answers identically in both worlds: the
      // fence check passes again and the inner create/settle is served
      // idempotently from the stored child.
      return same(b, f) ? "reapply" : "ambiguous";

    default:
      return "ambiguous";
  }
}

// =============================================================================
// SCHEDULES
// =============================================================================
//
// Schedules do not belong to any origin: a schedule's promise id is a
// template, so the promises it fires may land in many origins. Each schedule
// is its own document in the timeout bucket (`sched/<id>`), advanced by ETag
// CAS exactly like a workflow document.

export interface ScheduleDoc {
  id: string;
  cron: string;
  promiseId: string;
  promiseTimeout: number;
  promiseParam?: Value;
  promiseTags: Record<string, string>;
  createdAt: number;
  nextRunAt: number;
  lastRunAt: number | null;
}

export function toScheduleRecord(doc: ScheduleDoc): ScheduleRecord {
  const record: ScheduleRecord = {
    id: doc.id,
    cron: doc.cron,
    promiseId: doc.promiseId,
    promiseTimeout: doc.promiseTimeout,
    promiseParam: doc.promiseParam ?? {},
    promiseTags: doc.promiseTags,
    createdAt: doc.createdAt,
    nextRunAt: doc.nextRunAt,
  };
  if (doc.lastRunAt !== null) record.lastRunAt = doc.lastRunAt;
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
 * on which machine woke up.
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

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Create-time validation, mirroring the Resonate server. The prefix rules are
 * not cosmetic here: `resonate:origin` is what selects the document, so an id
 * that does not sit under its own origin would be written to a document that
 * cannot be found again from the id.
 */
export function validateCreate(id: string, timeoutAt: number, tags: Record<string, string>): string | null {
  if (id.length === 0) return "Promise ID is required";
  if (id.includes("\0")) return "Promise ID must not contain null bytes";
  if (!Number.isSafeInteger(timeoutAt) || timeoutAt < 0) return "TimeoutAt must be a non-negative integer";

  const origin = tags["resonate:origin"];
  if (origin !== undefined) {
    if (origin.includes("."))
      return "resonate:origin must not contain '.': re-rooted (detached) lineages are not supported by S3Network — the origin partition cannot represent them";
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
