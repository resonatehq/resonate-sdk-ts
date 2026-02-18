import type { MessageSource, Network } from "./network.js";
import { CronExpressionParser } from "cron-parser";
import {
  type DebugResetRes,
  type DebugSnapRes,
  type DebugStartRes,
  type DebugStopRes,
  type DebugTickAction,
  type DebugTickReq,
  type DebugTickRes,
  isSuccess,
  type Message,
  type PromiseCreateReq,
  type PromiseCreateRes,
  type PromiseGetReq,
  type PromiseGetRes,
  type PromiseRecord,
  type PromiseRegisterReq,
  type PromiseRegisterRes,
  type PromiseSettleReq,
  type PromiseSettleRes,
  type PromiseSubscribeReq,
  type PromiseSubscribeRes,
  type Request,
  type Response,
  type ScheduleCreateReq,
  type ScheduleCreateRes,
  type ScheduleDeleteReq,
  type ScheduleDeleteRes,
  type ScheduleGetReq,
  type ScheduleGetRes,
  type ScheduleRecord,
  type TaskAcquireReq,
  type TaskAcquireRes,
  type TaskCreateReq,
  type TaskCreateRes,
  type TaskFenceReq,
  type TaskFenceRes,
  type TaskFulfillReq,
  type TaskFulfillRes,
  type TaskGetReq,
  type TaskGetRes,
  type TaskHeartbeatReq,
  type TaskHeartbeatRes,
  type TaskRecord,
  type TaskReleaseReq,
  type TaskReleaseRes,
  type TaskSuspendReq,
  type TaskSuspendRes,
  type Value,
} from "./types.ts";

export interface PTimeout {
  id: string;
  timeout: number;
}

export interface TTimeout {
  id: string;
  type: 0 | 1; // 0 = pending retry, 1 = lease timeout
  timeout: number;
}

export interface STimeout {
  id: string;
  timeout: number;
}

export type PromiseState = "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";

export interface Promise {
  id: string;
  state: PromiseState;
  param: Value;
  value: Value;
  tags: Record<string, string>;
  timeoutAt: number;
  createdAt: number;
  settledAt: number | null;
  awaiters: Set<string>; // IDs of promises waiting on this one
  subscribers: Set<string>; // addresses subscribed to this promise
}

export type TaskState = "pending" | "acquired" | "suspended" | "fulfilled";

export interface Task {
  id: string;
  state: TaskState;
  version: number;
  pid?: string;
  ttl?: number;
  current?: string; // promise ID of the current message (c in the spec)
  pending: Set<string>; // awaited IDs that resolved while task was pending/acquired
}

export interface Schedule {
  id: string;
  cron: string; // A cron expression (standard 5-field format) specifying when to create promises.
  promiseId: string; // A template for the promise identifier. Supports {{.id}} and {{.timestamp}} substitutions
  promiseTimeout: number; // The timeout in milliseconds for created promises.
  promiseParam: Value; // The parameters for created promises. The data field is base64 encoded.
  promiseTags: Record<string, string>; // Tags for created promises.
  createdAt: number; // Unix timestamp in milliseconds when the schedule was created.
  lastRunAt?: number; // Unix timestamp in milliseconds of the last run. Only present if the schedule has run at least once.
}

// =============================================================================
// CHANGE TRACKING
// =============================================================================

export type Change =
  | { kind: "promise.set"; promise: PromiseRecord }
  | { kind: "task.set"; task: TaskRecord }
  | { kind: "schedule.set"; schedule: ScheduleRecord }
  | { kind: "schedule.del"; id: string }
  | { kind: "ptimeout.set"; timeout: { id: string; timeout: number } }
  | { kind: "ptimeout.del"; id: string }
  | { kind: "ttimeout.set"; timeout: { id: string; type: number; timeout: number } }
  | { kind: "ttimeout.del"; id: string }
  | { kind: "stimeout.set"; timeout: { id: string; timeout: number } }
  | { kind: "stimeout.del"; id: string }
  | { kind: "message.send"; address: string; message: Message };

// =============================================================================
// CONSTANTS
// =============================================================================

const PENDING_RETRY_TTL = 30000;

// =============================================================================
// SERVER
// =============================================================================

export class Server {
  promises = new Map<string, Promise>();
  tasks = new Map<string, Task>();
  schedules = new Map<string, Schedule>();
  pTimeouts: PTimeout[] = [];
  tTimeouts: TTimeout[] = [];
  sTimeouts: STimeout[] = [];
  outgoing: { address: string; message: Message }[] = [];

  apply(now: number, req: Request): { response: Response; changes: Change[] } {
    const changes: Change[] = [];

    const error = this.validate(req);
    if (error !== null) {
      return { response: { kind: req.kind, head: { status: 400 }, data: error } as Response, changes };
    }

    let result: { response: Response; changes: Change[] };
    switch (req.kind) {
      case "promise.get": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        result = this.promiseGet(now, req);
        break;
      }
      case "promise.create": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        result = this.promiseCreate(now, req);
        break;
      }
      case "promise.settle": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        result = this.promiseSettle(now, req);
        break;
      }
      case "promise.register": {
        changes.push(...this.tryAutoTimeout(now, req.data.awaited));
        changes.push(...this.tryAutoTimeout(now, req.data.awaiter));
        result = this.promiseRegister(now, req);
        break;
      }
      case "promise.subscribe": {
        changes.push(...this.tryAutoTimeout(now, req.data.awaited));
        result = this.promiseSubscribe(now, req);
        break;
      }
      case "task.get": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        result = this.taskGet(now, req);
        break;
      }
      case "task.create": {
        changes.push(...this.tryAutoTimeout(now, req.data.action.data.id));
        result = this.taskCreate(now, req);
        break;
      }
      case "task.acquire": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        result = this.taskAcquire(now, req);
        break;
      }
      case "task.release": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        result = this.taskRelease(now, req);
        break;
      }
      case "task.fulfill": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        result = this.taskFulfill(now, req);
        break;
      }
      case "task.suspend": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        for (const action of req.data.actions) {
          changes.push(...this.tryAutoTimeout(now, action.data.awaited));
        }
        result = this.taskSuspend(now, req);
        break;
      }
      case "task.fence": {
        changes.push(...this.tryAutoTimeout(now, req.data.id));
        changes.push(...this.tryAutoTimeout(now, req.data.action.data.id));
        result = this.taskFence(now, req);
        break;
      }
      case "task.heartbeat": {
        result = this.taskHeartbeat(now, req);
        break;
      }
      case "debug.start": {
        result = this.debugStart();
        break;
      }
      case "debug.reset": {
        result = this.debugReset();
        break;
      }
      case "debug.snap": {
        result = this.debugSnap();
        break;
      }
      case "debug.tick": {
        result = this.debugTick(req);
        break;
      }
      case "debug.stop": {
        result = this.debugStop();
        break;
      }
      case "schedule.get": {
        result = this.scheduleGet(req);
        break;
      }
      case "schedule.create": {
        result = this.scheduleCreate(now, req);
        break;
      }
      case "schedule.delete": {
        result = this.scheduleDelete(req);
        break;
      }
    }

    changes.push(...result.changes);
    return { response: result.response, changes };
  }

  private validate(req: Request): string | null {
    switch (req.kind) {
      case "promise.register":
        if (req.data.awaited === req.data.awaiter) {
          return "Awaited and awaiter must be different";
        }
        return null;
      case "task.suspend":
        if (req.data.actions.length === 0) {
          return "Actions list must not be empty";
        }
        if (req.data.actions.some((a) => a.data.awaiter !== req.data.id)) {
          return "Awaiter must be the suspending task";
        }
        if (req.data.actions.some((a) => a.data.awaited === req.data.id)) {
          return "Task cannot await its own promise";
        }
        return null;
      case "task.create":
        if (!req.data.action.data.tags?.["resonate:target"]) {
          return "Action must have a resonate:target tag";
        }
        return null;
      case "task.fulfill":
        if (req.data.action.data.id !== req.data.id) {
          return "Promise ID must match task ID";
        }
        return null;
      default:
        return null;
    }
  }

  // ===========================================================================
  // PROMISE OPERATIONS
  // ===========================================================================

  private promiseGet(now: number, req: PromiseGetReq): { response: PromiseGetRes; changes: Change[] } {
    const promise = this.promises.get(req.data.id);
    if (!promise) {
      return { response: this.response("promise.get", 404, "Promise not found"), changes: [] };
    }
    return { response: this.response("promise.get", 200, { promise: this.toPromiseRecord(promise) }), changes: [] };
  }

  private promiseCreate(now: number, req: PromiseCreateReq): { response: PromiseCreateRes; changes: Change[] } {
    const existing = this.promises.get(req.data.id);
    if (existing) {
      return {
        response: this.response("promise.create", 200, { promise: this.toPromiseRecord(existing) }),
        changes: [],
      };
    }

    const changes: Change[] = [];

    // Check if the promise is already timed out at creation
    if (now >= req.data.timeoutAt) {
      const promise: Promise = {
        id: req.data.id,
        state: this.timeoutState(req.data.tags),
        param: req.data.param ?? { data: undefined, headers: undefined },
        value: {},
        tags: req.data.tags,
        createdAt: req.data.timeoutAt,
        settledAt: req.data.timeoutAt,
        timeoutAt: req.data.timeoutAt,
        awaiters: new Set(),
        subscribers: new Set(),
      };
      changes.push(this.setPromise(promise));
      changes.push(...this.enqueueSettle(req.data.id));
      changes.push(...this.resumeAwaiters(req.data.id, now));
      changes.push(...this.notifySubscribers(req.data.id));

      return { response: this.response("promise.create", 200, { promise: this.toPromiseRecord(promise) }), changes };
    }

    const promise: Promise = {
      id: req.data.id,
      state: "pending",
      param: req.data.param ?? { data: undefined, headers: undefined },
      value: {},
      tags: req.data.tags,
      createdAt: now,
      settledAt: null,
      timeoutAt: req.data.timeoutAt,
      awaiters: new Set(),
      subscribers: new Set(),
    };
    changes.push(this.setPromise(promise));
    changes.push(this.setPTimeout({ id: req.data.id, timeout: req.data.timeoutAt }));

    const address = req.data.tags["resonate:target"];
    if (address) {
      const task: Task = {
        id: req.data.id,
        state: "pending",
        version: 0,
        current: req.data.id,
        pending: new Set(),
      };
      changes.push(this.setTask(task));
      changes.push(
        this.setTTimeout({
          id: req.data.id,
          type: 0,
          timeout: now + PENDING_RETRY_TTL,
        }),
      );
      changes.push(
        this.sendMessage(address, { kind: "execute", head: {}, data: { task: { id: req.data.id, version: 0 } } }),
      );
    }

    return { response: this.response("promise.create", 200, { promise: this.toPromiseRecord(promise) }), changes };
  }

  private promiseSettle(now: number, req: PromiseSettleReq): { response: PromiseSettleRes; changes: Change[] } {
    const promise = this.promises.get(req.data.id);
    if (!promise) {
      return { response: this.response("promise.settle", 404, "Promise not found"), changes: [] };
    }

    if (promise.state !== "pending") {
      return {
        response: this.response("promise.settle", 200, { promise: this.toPromiseRecord(promise) }),
        changes: [],
      };
    }

    const changes: Change[] = [];

    const settled: Promise = {
      ...promise,
      state: req.data.state,
      value: req.data.value,
      settledAt: now,
    };
    changes.push(this.setPromise(settled));
    changes.push(this.delPTimeout(req.data.id));
    changes.push(...this.enqueueSettle(req.data.id));
    changes.push(...this.resumeAwaiters(req.data.id, now));
    changes.push(...this.notifySubscribers(req.data.id));

    return { response: this.response("promise.settle", 200, { promise: this.toPromiseRecord(settled) }), changes };
  }

  private promiseRegister(now: number, req: PromiseRegisterReq): { response: PromiseRegisterRes; changes: Change[] } {
    const awaitedPromise = this.promises.get(req.data.awaited);
    if (!awaitedPromise) {
      return { response: this.response("promise.register", 404, "Awaited promise not found"), changes: [] };
    }

    const awaiterPromise = this.promises.get(req.data.awaiter);
    if (!awaiterPromise) {
      return { response: this.response("promise.register", 422, "Awaiter promise not found"), changes: [] };
    }

    // HasAddress check: awaiter must have a resonate:target tag
    if (!awaiterPromise.tags["resonate:target"]) {
      return { response: this.response("promise.register", 422, "Awaiter has no address"), changes: [] };
    }

    const changes: Change[] = [];

    // Add to awaiters if awaited is pending and awaiter is not settled
    if (awaitedPromise.state === "pending" && awaiterPromise.state === "pending") {
      awaitedPromise.awaiters.add(req.data.awaiter);
      changes.push(this.setPromise(awaitedPromise));
    }

    return {
      response: this.response("promise.register", 200, { promise: this.toPromiseRecord(awaitedPromise) }),
      changes,
    };
  }

  private promiseSubscribe(
    now: number,
    req: PromiseSubscribeReq,
  ): { response: PromiseSubscribeRes; changes: Change[] } {
    const promise = this.promises.get(req.data.awaited);
    if (!promise) {
      return { response: this.response("promise.subscribe", 404, "Promise not found"), changes: [] };
    }

    const changes: Change[] = [];

    // Add subscriber if promise is pending
    if (promise.state === "pending") {
      promise.subscribers.add(req.data.address);
      changes.push(this.setPromise(promise));
    }

    return { response: this.response("promise.subscribe", 200, { promise: this.toPromiseRecord(promise) }), changes };
  }

  // ===========================================================================
  // TASK OPERATIONS
  // ===========================================================================

  private taskGet(now: number, req: TaskGetReq): { response: TaskGetRes; changes: Change[] } {
    const task = this.tasks.get(req.data.id);
    if (!task) {
      return { response: this.response("task.get", 404, "Task not found"), changes: [] };
    }
    return { response: this.response("task.get", 200, { task: this.toTaskRecord(task) }), changes: [] };
  }

  private taskCreate(now: number, req: TaskCreateReq): { response: TaskCreateRes; changes: Change[] } {
    const existingTask = this.tasks.get(req.data.action.data.id);
    if (existingTask) {
      return { response: this.response("task.create", 409, "Task already exists"), changes: [] };
    }

    const { response: result, changes } = this.promiseCreate(now, req.data.action);

    if (!isSuccess(result)) {
      throw new Error(`Invariant violation: promiseCreate failed with status ${result.head.status}`);
    }
    const promiseRecord = result.data.promise;
    const task = this.getTaskOrThrow(promiseRecord.id);

    return {
      response: this.response("task.create", 200, {
        task: this.toTaskRecord(task),
        promise: promiseRecord,
      }),
      changes,
    };
  }

  private taskAcquire(now: number, req: TaskAcquireReq): { response: TaskAcquireRes; changes: Change[] } {
    const task = this.tasks.get(req.data.id);
    if (!task) {
      return { response: this.response("task.acquire", 404, "Task not found"), changes: [] };
    }
    if (task.state !== "pending") {
      return { response: this.response("task.acquire", 409, "Task not in pending state"), changes: [] };
    }
    if (task.version !== req.data.version) {
      return { response: this.response("task.acquire", 409, "Version mismatch"), changes: [] };
    }

    const changes: Change[] = [];
    const promise = this.getPromiseOrThrow(req.data.id);
    changes.push(this.setTask({ ...task, state: "acquired", pid: req.data.pid, ttl: req.data.ttl }));
    changes.push(this.setTTimeout({ id: req.data.id, type: 1, timeout: now + req.data.ttl }));

    return {
      response: this.response("task.acquire", 200, {
        promise: this.toPromiseRecord(promise),
        preload: [],
      }),
      changes,
    };
  }

  private taskRelease(now: number, req: TaskReleaseReq): { response: TaskReleaseRes; changes: Change[] } {
    const task = this.tasks.get(req.data.id);
    if (!task) {
      return { response: this.response("task.release", 404, "Task not found"), changes: [] };
    }
    if (task.state !== "acquired") {
      return { response: this.response("task.release", 409, "Task not acquired"), changes: [] };
    }
    if (task.version !== req.data.version) {
      return { response: this.response("task.release", 409, "Version mismatch"), changes: [] };
    }

    const changes: Change[] = [];
    const newVersion = task.version + 1;
    changes.push(this.setTask({ ...task, state: "pending", version: newVersion, pid: undefined }));
    changes.push(this.setTTimeout({ id: req.data.id, type: 0, timeout: now + PENDING_RETRY_TTL }));

    const promise = this.getPromiseOrThrow(req.data.id);
    const address = this.getAddressOrThrow(promise);
    changes.push(
      this.sendMessage(address, {
        kind: "execute",
        head: {},
        data: { task: { id: req.data.id, version: newVersion } },
      }),
    );

    return { response: this.response("task.release", 200, {}), changes };
  }

  private taskFulfill(now: number, req: TaskFulfillReq): { response: TaskFulfillRes; changes: Change[] } {
    const task = this.tasks.get(req.data.id);
    if (!task) {
      return { response: this.response("task.fulfill", 404, "Task not found"), changes: [] };
    }
    if (task.state !== "acquired") {
      return { response: this.response("task.fulfill", 409, "Task not acquired"), changes: [] };
    }
    if (task.version !== req.data.version) {
      return { response: this.response("task.fulfill", 409, "Version mismatch"), changes: [] };
    }

    const settle = req.data.action.data;
    const promise = this.getPromiseOrThrow(settle.id);

    const changes: Change[] = [];

    // Check if promise is already settled (possibly by auto-timeout above)
    if (promise.state !== "pending") {
      // Still fulfill the task but indicate the promise was already settled
      changes.push(...this.enqueueSettle(req.data.id));

      return { response: this.response("task.fulfill", 200, { promise: this.toPromiseRecord(promise) }), changes };
    }

    // Settle the promise
    const settled: Promise = {
      ...promise,
      state: settle.state,
      value: settle.value ?? {},
      settledAt: now,
    };
    changes.push(this.setPromise(settled));
    changes.push(this.delPTimeout(settle.id));
    changes.push(...this.enqueueSettle(req.data.id));
    changes.push(...this.resumeAwaiters(settle.id, now));
    changes.push(...this.notifySubscribers(settle.id));

    return { response: this.response("task.fulfill", 200, { promise: this.toPromiseRecord(settled) }), changes };
  }

  private taskSuspend(now: number, req: TaskSuspendReq): { response: TaskSuspendRes; changes: Change[] } {
    const task = this.tasks.get(req.data.id);
    if (!task) {
      return { response: this.response("task.suspend", 404, "Task not found"), changes: [] };
    }
    if (task.state !== "acquired") {
      return { response: this.response("task.suspend", 409, "Task not acquired"), changes: [] };
    }
    if (task.version !== req.data.version) {
      return { response: this.response("task.suspend", 409, "Version mismatch"), changes: [] };
    }

    const changes: Change[] = [];

    // Immediate resume — stay acquired, pop one from pending
    if (task.pending.size > 0) {
      const [next] = task.pending;
      task.pending.delete(next);
      changes.push(this.setTask({ ...task, current: next }));
      return { response: this.response("task.suspend", 300, {}), changes };
    }

    // Register this task as an awaiter on each awaited promise.
    // The awaiter is always req.data.id (validated above).
    const triggers: string[] = [];

    for (const action of req.data.actions) {
      const awaitedPromise = this.promises.get(action.data.awaited);
      if (!awaitedPromise) {
        return { response: this.response("task.suspend", 422, {}), changes: [] };
      }

      if (awaitedPromise.state === "pending") {
        awaitedPromise.awaiters.add(req.data.id);
        changes.push(this.setPromise(awaitedPromise));
      } else {
        // Already settled → immediate trigger
        triggers.push(action.data.awaited);
      }
    }

    if (triggers.length > 0) {
      return { response: this.response("task.suspend", 300, {}), changes };
    }

    // Actually suspend
    changes.push(this.setTask({ ...task, state: "suspended", pid: undefined, current: undefined, pending: new Set() }));
    changes.push(this.delTTimeout(req.data.id));

    return { response: this.response("task.suspend", 200, {}), changes };
  }

  private taskFence(now: number, req: TaskFenceReq): { response: TaskFenceRes; changes: Change[] } {
    const task = this.tasks.get(req.data.id);
    if (!task) {
      return { response: this.response("task.fence", 404, "Task not found"), changes: [] };
    }
    if (task.state !== "acquired") {
      return { response: this.response("task.fence", 409, "Fence check failed"), changes: [] };
    }
    if (task.version !== req.data.version) {
      return { response: this.response("task.fence", 409, "Fence check failed"), changes: [] };
    }

    const changes: Change[] = [];

    const action = req.data.action;

    if (action.kind === "promise.create") {
      const inner = this.fenceCreate(now, action);
      changes.push(...inner.changes);
      return { response: inner.response, changes };
    } else {
      const inner = this.fenceSettle(now, action);
      changes.push(...inner.changes);
      return { response: inner.response, changes };
    }
  }

  private fenceCreate(now: number, req: PromiseCreateReq): { response: TaskFenceRes; changes: Change[] } {
    const { response: result, changes } = this.promiseCreate(now, req);
    return {
      response: this.response("task.fence", 200, {
        action: {
          kind: "promise.create",
          head: { status: result.head.status },
          data: result.data,
        },
      }),
      changes,
    };
  }

  private fenceSettle(now: number, req: PromiseSettleReq): { response: TaskFenceRes; changes: Change[] } {
    const { response: result, changes } = this.promiseSettle(now, req);
    return {
      response: this.response("task.fence", 200, {
        action: {
          kind: "promise.settle",
          head: { status: 200 },
          data: result.data,
        },
      }),
      changes,
    };
  }

  private taskHeartbeat(now: number, req: TaskHeartbeatReq): { response: TaskHeartbeatRes; changes: Change[] } {
    const changes: Change[] = [];

    for (const ref of req.data.tasks) {
      const task = this.tasks.get(ref.id);
      if (!task || task.state !== "acquired" || task.version !== ref.version || task.pid !== req.data.pid) {
        continue;
      }

      const ttl = task.ttl ?? 30000;
      changes.push(this.setTTimeout({ id: ref.id, type: 1, timeout: now + ttl }));
    }

    return { response: this.response("task.heartbeat", 200, {}), changes };
  }

  // ===========================================================================
  // SCHEDULE OPERATIONS
  // ===========================================================================

  private scheduleGet(req: ScheduleGetReq): { response: ScheduleGetRes; changes: Change[] } {
    const schedule = this.schedules.get(req.data.id);
    if (!schedule) {
      return { response: this.response("schedule.get", 404, "Schedule not found"), changes: [] };
    }
    return { response: this.response("schedule.get", 200, { schedule: this.toScheduleRecord(schedule) }), changes: [] };
  }

  private scheduleCreate(now: number, req: ScheduleCreateReq): { response: ScheduleCreateRes; changes: Change[] } {
    const existing = this.schedules.get(req.data.id);
    if (existing) {
      return {
        response: this.response("schedule.create", 200, { schedule: this.toScheduleRecord(existing) }),
        changes: [],
      };
    }

    let nextRunAt: number;
    try {
      const interval = CronExpressionParser.parse(req.data.cron, { currentDate: new Date(now) });
      nextRunAt = interval.next().getTime();
    } catch {
      return { response: this.response("schedule.create", 400, "Invalid cron expression"), changes: [] };
    }

    const changes: Change[] = [];

    const schedule: Schedule = {
      id: req.data.id,
      cron: req.data.cron,
      promiseId: req.data.promiseId,
      promiseTimeout: req.data.promiseTimeout,
      promiseParam: req.data.promiseParam,
      promiseTags: req.data.promiseTags,
      createdAt: now,
    };
    changes.push(this.setSTimeout({ id: schedule.id, timeout: nextRunAt }));
    changes.push(this.setSchedule(schedule));

    return { response: this.response("schedule.create", 200, { schedule: this.toScheduleRecord(schedule) }), changes };
  }

  private scheduleDelete(req: ScheduleDeleteReq): { response: ScheduleDeleteRes; changes: Change[] } {
    const schedule = this.schedules.get(req.data.id);
    if (!schedule) {
      return { response: this.response("schedule.delete", 404, "Schedule not found"), changes: [] };
    }

    const changes: Change[] = [];
    changes.push(this.delSTimeout(req.data.id));
    changes.push(this.delSchedule(req.data.id));

    return { response: this.response("schedule.delete", 200, {}), changes };
  }

  // ===========================================================================
  // DEBUG OPERATIONS
  // ===========================================================================

  private debugStart(): { response: DebugStartRes; changes: Change[] } {
    return { response: this.response("debug.start", 200, {}), changes: [] };
  }

  private debugReset(): { response: DebugResetRes; changes: Change[] } {
    this.promises.clear();
    this.tasks.clear();
    this.schedules.clear();
    this.outgoing = [];
    this.pTimeouts = [];
    this.tTimeouts = [];
    this.sTimeouts = [];
    return { response: this.response("debug.reset", 200, {}), changes: [] };
  }

  private debugSnap(): { response: DebugSnapRes; changes: Change[] } {
    return {
      response: this.response("debug.snap", 200, {
        promises: Array.from(this.promises.values()).map((p) => this.toPromiseRecord(p)),
        promiseTimeouts: this.pTimeouts,
        callbacks: Array.from(this.promises.values()).flatMap((p) =>
          [...p.awaiters].map((awaiter) => ({ awaiter, awaited: p.id })),
        ),
        subscriptions: Array.from(this.promises.values()).flatMap((p) =>
          [...p.subscribers].map((address) => ({ id: p.id, address })),
        ),
        tasks: Array.from(this.tasks.values()).map((t) => this.toTaskRecord(t)),
        taskTimeouts: this.tTimeouts,
        messages: this.outgoing,
      }),
      changes: [],
    };
  }

  private debugTick(req: DebugTickReq): { response: DebugTickRes; changes: Change[] } {
    const now = req.data.time;
    const changes: Change[] = [];
    const actions: DebugTickAction[] = [];

    // Promise timeouts -> settle as rejected_timedout (or resolved for timer promises)
    for (const pt of this.pTimeouts) {
      if (now >= pt.timeout) {
        const promise = this.getPromiseOrThrow(pt.id);
        if (promise.state === "pending") {
          const state = this.timeoutState(promise.tags);
          actions.push({
            kind: "promise.settle",
            data: { id: pt.id, state },
          });
        }
      }
    }

    // Task timeouts -> release (lease) or retry (pending)
    for (const tt of this.tTimeouts) {
      if (now < tt.timeout) continue;
      if (tt.type === 1) {
        const task = this.getTaskOrThrow(tt.id);
        if (task.state === "acquired") {
          actions.push({
            kind: "task.release",
            data: { id: tt.id, version: task.version },
          });
        }
      } else if (tt.type === 0) {
        const task = this.getTaskOrThrow(tt.id);
        if (task.state === "pending") {
          actions.push({
            kind: "task.retry",
            data: { id: tt.id, version: task.version },
          });
        }
      }
    }

    // Apply actions to own state. Promise settlements are split into three
    // phases to make the tick atomic — the result must not depend on the
    // order promises appear in pTimeouts.
    //
    //   Phase 1: Settle all expired promises (state change only).
    //   Phase 2: Fulfill tasks whose own promise settled (enqueueSettle).
    //   Phase 3: Resume suspended awaiters of settled promises (resumeAwaiters).
    //
    // Phase 2 before phase 3 ensures that a task whose own promise settled
    // is fulfilled before resumeAwaiters runs. This prevents a spurious
    // suspended → pending (version++) → fulfilled path for tasks that
    // should go directly suspended → fulfilled.

    const settledIds: string[] = [];

    // Phase 1: Settle promises
    for (const action of actions) {
      if (action.kind === "promise.settle") {
        const promise = this.getPromiseOrThrow(action.data.id);
        if (promise.state !== "pending") continue;

        changes.push(
          this.setPromise({
            ...promise,
            state: action.data.state,
            value: {},
            settledAt: promise.timeoutAt,
          }),
        );

        changes.push(this.delPTimeout(action.data.id));

        settledIds.push(action.data.id);
      }
    }

    // Phase 2: Fulfill tasks whose own promise settled
    for (const id of settledIds) {
      changes.push(...this.enqueueSettle(id));
    }

    // Phase 3: Resume suspended awaiters and notify subscribers
    for (const id of settledIds) {
      changes.push(...this.resumeAwaiters(id, now));
      changes.push(...this.notifySubscribers(id));
    }

    for (const action of actions) {
      if (action.kind === "task.release") {
        const task = this.getTaskOrThrow(action.data.id);
        if (task.state === "acquired" && task.version === action.data.version) {
          const newVersion = task.version + 1;
          changes.push(this.setTask({ ...task, state: "pending", version: newVersion, pid: undefined }));
          changes.push(this.setTTimeout({ id: action.data.id, type: 0, timeout: now + PENDING_RETRY_TTL }));

          const promise = this.getPromiseOrThrow(action.data.id);
          const address = this.getAddressOrThrow(promise);
          changes.push(
            this.sendMessage(address, {
              kind: "execute",
              head: {},
              data: { task: { id: action.data.id, version: newVersion } },
            }),
          );
        }
      } else if (action.kind === "task.retry") {
        const task = this.getTaskOrThrow(action.data.id);
        if (task.state === "pending") {
          changes.push(this.setTTimeout({ id: action.data.id, type: 0, timeout: now + PENDING_RETRY_TTL }));

          const promise = this.getPromiseOrThrow(action.data.id);
          const address = this.getAddressOrThrow(promise);
          changes.push(
            this.sendMessage(address, {
              kind: "execute",
              head: {},
              data: { task: { id: action.data.id, version: task.version } },
            }),
          );
        }
      }
    }

    // Schedule timeouts -> create promises for due schedules
    for (const st of this.sTimeouts) {
      if (now < st.timeout) continue;

      const schedule = this.getScheduleOrThrow(st.id);

      const promiseId = schedule.promiseId
        .replaceAll("{{.id}}", schedule.id)
        .replaceAll("{{.timestamp}}", String(st.timeout));

      const { changes: createChanges } = this.promiseCreate(now, {
        kind: "promise.create",
        head: { corrId: "", version: "" },
        data: {
          id: promiseId,
          timeoutAt: st.timeout + schedule.promiseTimeout,
          param: schedule.promiseParam,
          tags: schedule.promiseTags,
        },
      });
      changes.push(...createChanges);

      // Advance to next run
      const interval = CronExpressionParser.parse(schedule.cron, {
        currentDate: new Date(st.timeout),
      });
      const nextRunAt = interval.next().getTime();
      schedule.lastRunAt = st.timeout;
      changes.push(this.setSTimeout({ id: schedule.id, timeout: nextRunAt }));
      changes.push(this.setSchedule(schedule));
    }

    return { response: this.response("debug.tick", 200, []), changes };
  }

  private debugStop(): { response: DebugStopRes; changes: Change[] } {
    return { response: this.response("debug.stop", 200, {}), changes: [] };
  }

  // ===========================================================================
  // CONVERTERS
  // ===========================================================================

  private toPromiseRecord(p: Promise): PromiseRecord {
    const { awaiters, subscribers, settledAt, ...rest } = p;
    return settledAt != null ? { ...rest, settledAt } : rest;
  }

  private toTaskRecord(t: Task): TaskRecord {
    return { id: t.id, version: t.version, state: t.state };
  }

  private toScheduleRecord(s: Schedule): ScheduleRecord {
    const st = this.sTimeouts.find((e) => e.id === s.id);
    const record: ScheduleRecord = {
      id: s.id,
      cron: s.cron,
      promiseId: s.promiseId,
      promiseTimeout: s.promiseTimeout,
      promiseParam: s.promiseParam,
      promiseTags: s.promiseTags,
      createdAt: s.createdAt,
      nextRunAt: st!.timeout,
    };
    if (s.lastRunAt != null) {
      record.lastRunAt = s.lastRunAt;
    }
    return record;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private tryAutoTimeout(now: number, id: string): Change[] {
    const promise = this.promises.get(id);
    if (!promise || promise.state !== "pending" || now < promise.timeoutAt) {
      return [];
    }

    const changes: Change[] = [];

    const state = this.timeoutState(promise.tags);
    changes.push(this.setPromise({ ...promise, state, settledAt: promise.timeoutAt }));
    changes.push(this.delPTimeout(id));
    changes.push(...this.enqueueSettle(id));
    changes.push(...this.resumeAwaiters(id, now));
    changes.push(...this.notifySubscribers(id));

    return changes;
  }

  private enqueueSettle(promiseId: string): Change[] {
    const task = this.tasks.get(promiseId);
    if (!task || task.state === "fulfilled") return [];

    const changes: Change[] = [];

    changes.push(this.setTask({ ...task, state: "fulfilled", pid: undefined, current: undefined }));
    changes.push(this.delTTimeout(promiseId));

    // Remove this task from all promise awaiters (delete callbacks where awaiter_id = task_id)
    for (const [, promise] of this.promises) {
      if (promise.awaiters.delete(promiseId)) {
        changes.push(this.setPromise(promise));
      }
    }

    return changes;
  }

  private resumeAwaiters(promiseId: string, now: number): Change[] {
    const settledPromise = this.getPromiseOrThrow(promiseId);

    const changes: Change[] = [];

    // Resume or buffer for all tasks that were awaiting this promise
    for (const awaiterId of settledPromise.awaiters) {
      const task = this.getTaskOrThrow(awaiterId);

      if (task.state === "suspended") {
        const newVersion = task.version + 1;
        changes.push(this.setTask({ ...task, state: "pending", version: newVersion, current: promiseId }));

        // Add task timeout entry back (type=0 for pending retry)
        changes.push(
          this.setTTimeout({
            id: awaiterId,
            type: 0,
            timeout: now + PENDING_RETRY_TTL,
          }),
        );

        const awaiterPromise = this.getPromiseOrThrow(awaiterId);
        const address = this.getAddressOrThrow(awaiterPromise);
        changes.push(
          this.sendMessage(address, {
            kind: "execute",
            head: {},
            data: { task: { id: awaiterId, version: newVersion } },
          }),
        );
      } else if (task.state === "pending" || task.state === "acquired") {
        // Buffer the resume — will be checked when task suspends
        task.pending.add(promiseId);
        changes.push(this.setTask(task));
      }
    }

    // Clear awaiters after processing
    settledPromise.awaiters.clear();
    changes.push(this.setPromise(settledPromise));

    return changes;
  }

  private notifySubscribers(promiseId: string): Change[] {
    const promise = this.getPromiseOrThrow(promiseId);
    if (promise.subscribers.size === 0) return [];

    const changes: Change[] = [];

    for (const address of promise.subscribers) {
      changes.push(
        this.sendMessage(address, {
          kind: "notify",
          head: {},
          data: { promise: this.toPromiseRecord(promise) },
        }),
      );
    }

    promise.subscribers.clear();
    changes.push(this.setPromise(promise));

    return changes;
  }

  private timeoutState(tags: Record<string, string>): "resolved" | "rejected_timedout" {
    return tags["resonate:timer"] === "true" ? "resolved" : "rejected_timedout";
  }

  private getPromiseOrThrow(id: string): Promise {
    const promise = this.promises.get(id);
    if (!promise) {
      throw new Error(`Invariant violation: promise ${id} not found`);
    }
    return promise;
  }

  private getAddressOrThrow(promise: Promise): string {
    const address = promise.tags["resonate:target"];
    if (!address) {
      throw new Error(`Invariant violation: promise ${promise.id} has no resonate:target tag`);
    }
    return address;
  }

  private getTaskOrThrow(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Invariant violation: task ${id} not found`);
    }
    return task;
  }
  private getScheduleOrThrow(id: string): Schedule {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new Error(`Invariant violation: schedule ${id} not found`);
    }
    return schedule;
  }

  // ===========================================================================
  // ACCESSORS (change-tracking)
  // ===========================================================================

  private setPromise(p: Promise): Change {
    this.promises.set(p.id, p);
    return { kind: "promise.set", promise: this.toPromiseRecord(p) };
  }

  private setTask(t: Task): Change {
    this.tasks.set(t.id, t);
    return { kind: "task.set", task: this.toTaskRecord(t) };
  }

  private setSchedule(s: Schedule): Change {
    this.schedules.set(s.id, s);
    return { kind: "schedule.set", schedule: this.toScheduleRecord(s) };
  }

  private delSchedule(id: string): Change {
    this.schedules.delete(id);
    return { kind: "schedule.del", id };
  }

  private setPTimeout(pt: PTimeout): Change {
    const idx = this.pTimeouts.findIndex((e) => e.id === pt.id);
    if (idx !== -1) {
      this.pTimeouts[idx] = pt;
    } else {
      this.pTimeouts.push(pt);
    }
    return { kind: "ptimeout.set", timeout: { id: pt.id, timeout: pt.timeout } };
  }

  private delPTimeout(id: string): Change {
    const idx = this.pTimeouts.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.pTimeouts.splice(idx, 1);
    }
    return { kind: "ptimeout.del", id };
  }

  private setTTimeout(tt: TTimeout): Change {
    const idx = this.tTimeouts.findIndex((e) => e.id === tt.id);
    if (idx !== -1) {
      this.tTimeouts[idx] = tt;
    } else {
      this.tTimeouts.push(tt);
    }
    return { kind: "ttimeout.set", timeout: { id: tt.id, type: tt.type, timeout: tt.timeout } };
  }

  private delTTimeout(id: string): Change {
    const idx = this.tTimeouts.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.tTimeouts.splice(idx, 1);
    }
    return { kind: "ttimeout.del", id };
  }

  private setSTimeout(st: STimeout): Change {
    const idx = this.sTimeouts.findIndex((e) => e.id === st.id);
    if (idx !== -1) {
      this.sTimeouts[idx] = st;
    } else {
      this.sTimeouts.push(st);
    }
    return { kind: "stimeout.set", timeout: { id: st.id, timeout: st.timeout } };
  }

  private delSTimeout(id: string): Change {
    const idx = this.sTimeouts.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.sTimeouts.splice(idx, 1);
    }
    return { kind: "stimeout.del", id };
  }

  // FIX: Change from accumulate (push) to upsert by task ID.
  // A task can only be claimed by one worker at one version, so when a task
  // is resumed (version incremented), the previous message is obsolete.
  // Upsert keeps only the latest message per task ID, matching the HTTP's
  // outgoing table behavior (ON CONFLICT (id) DO UPDATE).
  private sendMessage(address: string, msg: Message): Change {
    if (msg.kind === "execute") {
      const taskId = msg.data.task.id;
      const idx = this.outgoing.findIndex((m) => m.message.kind === "execute" && m.message.data.task.id === taskId);
      if (idx >= 0) {
        this.outgoing[idx] = { address, message: msg };
      } else {
        this.outgoing.push({ address, message: msg });
      }
    } else {
      this.outgoing.push({ address, message: msg });
    }
    return { kind: "message.send", address, message: msg };
  }
  // OLD: accumulate (push) — causes divergence with HTTP snapshots
  // private sendMessage(address: string, msg: Message): Change {
  //   this.outgoing.push({ address, message: msg });
  //   return { kind: "message.send", address, message: msg };
  // }

  private response<K extends Response["kind"]>(kind: K, status: number, data: unknown): Extract<Response, { kind: K }> {
    return { kind, head: { status }, data } as Extract<Response, { kind: K }>;
  }
}

// =============================================================================
// LOCAL NETWORK
// =============================================================================

export class LocalNetwork implements Network, MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private server: Server;
  private subscriptions: {
    execute: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { execute: [], notify: [] };
  private tickInterval?: ReturnType<typeof setInterval>;

  constructor({
    pid = crypto.randomUUID().replace(/-/g, ""),
    group = "default",
  }: {
    pid?: string;
    group?: string;
  } = {}) {
    this.server = new Server();
    this.pid = pid;
    this.group = group;
    this.unicast = `local://uni@${group}/${pid}`;
    this.anycast = `local://any@${group}/${pid}`;
  }

  // -- Network ---------------------------------------------------------------

  start(): void {
    this.tickInterval = setInterval(() => {
      const result = this.server.apply(Date.now());
      this.dispatchMessages(result);
    }, 1000);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }

  send<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
    _headers?: { [key: string]: string },
    _retryForever?: boolean,
  ): void {
    const { corrId, version } = req.head;

    // Handle request kinds the Server does not implement.
    const intercepted = this.intercept(req);
    if (intercepted) {
      callback({
        ...intercepted,
        head: { ...intercepted.head, corrId, version },
      } as Extract<Response, { kind: K }>);
      return;
    }

    const now = Date.now();
    const result = this.server.apply(now, req);
    const response = result.response;

    const res = {
      kind: response.kind,
      head: { corrId, status: response.head.status, version },
      data: response.data,
    } as Extract<Response, { kind: K }>;

    this.dispatchMessages(result);

    callback(res);
  }

  getMessageSource(): MessageSource {
    return this;
  }

  // -- MessageSource ---------------------------------------------------------

  recv(msg: Message): void {
    for (const cb of this.subscriptions[msg.kind]) {
      cb(msg);
    }
  }

  subscribe(type: "execute" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }

  // Arrow function to preserve `this` when extracted as a bare reference.
  match = (_target: string): string => {
    return this.anycast;
  };

  // -- internal: intercept ---------------------------------------------------

  /**
   * Handle SDK request kinds the Server does not implement.
   * Returns a partial Res if handled, or undefined to fall through.
   */
  private intercept(req: Request): Response | undefined {
    const head = { corrId: "" as const, status: 200 as const, version: "" as const };

    switch (req.kind) {
      // promise.subscribe: look up the promise and return it.
      case "promise.subscribe": {
        const sp = this.server.promises.get(req.data.awaited);
        if (!sp) {
          return {
            kind: "promise.subscribe",
            head: { corrId: "", status: 404 as const, version: "" },
            data: "Promise not found",
          };
        }
        return { kind: "promise.subscribe", head, data: { promise: this.toPromiseRecord(sp) } };
      }

      default:
        return undefined;
    }
  }

  // -- internal: message dispatch --------------------------------------------

  private dispatchMessages(result: ServerResult): void {
    const resumeIds = new Set(
      result.changes
        .filter((c): c is { kind: "DidTrigger"; awaiter: string } => c.kind === "DidTrigger")
        .map((c) => c.awaiter),
    );

    for (const msg of result.messages) {
      const task = { id: msg.id, version: msg.version };

      if (resumeIds.has(msg.id)) {
        this.recv({ kind: "execute", head: {}, data: { task } });
      } else {
        this.recv({ kind: "execute", head: {}, data: { task } });
      }
    }

    // DidSettle: send notify messages for settled promises.
    for (const change of result.changes) {
      if (change.kind === "DidSettle") {
        const sp = this.server.promises.get(change.id);
        if (sp) {
          this.recv({
            kind: "notify",
            head: {},
            data: { promise: this.toPromiseRecord(sp) },
          });
        }
      }
    }
  }

  // -- internal: type conversion ---------------------------------------------

  private toPromiseRecord(sp: ServerPromise): PromiseRecord {
    return {
      id: sp.id,
      state: sp.state,
      param: {
        headers: sp.param?.headers ?? {},
        data: sp.param?.data ?? "",
      },
      value: {
        headers: sp.value?.headers ?? {},
        data: sp.value?.data ?? "",
      },
      tags: sp.tags,
      timeoutAt: sp.timeoutAt,
      createdAt: sp.createdAt,
      settledAt: sp.settledAt ?? undefined,
    };
  }
}
