import { CronExpressionParser } from "cron-parser";

import type {
  CallbackRecord,
  DurablePromiseRecord,
  Mesg,
  RecvMsg,
  RequestMsg,
  ResponseMsg,
  ScheduleRecord,
  TaskRecord,
} from "./network/network";
import * as util from "./util";

interface DurablePromise {
  id: string;
  state: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
  timeout: number;
  param: any;
  value: any;
  tags: Record<string, string>;
  iKeyForCreate?: string;
  iKeyForComplete?: string;
  createdOn?: number;
  completedOn?: number;
  callbacks?: Map<string, Callback>;
}

interface Callback {
  id: string;
  type: "resume" | "notify";
  promiseId: string;
  rootPromiseId: string;
  recv: string;
  timeout: number;
  createdOn: number;
}

interface Task {
  id: string;
  counter: number;
  state: "init" | "enqueued" | "claimed" | "completed";
  type: "invoke" | "resume" | "notify";
  recv: string;
  rootPromiseId: string;
  leafPromiseId: string;
  processId?: string;
  ttl?: number;
  expiry?: number;
  createdOn: number;
  completedOn?: number;
}

interface Schedule {
  id: string;
  description?: string;
  cron: string;
  tags: Record<string, string>;
  promiseId: string;
  promiseTimeout: number;
  promiseParam: any;
  promiseTags: Record<string, string>;
  lastRunTime?: number;
  nextRunTime?: number;
  iKey?: string;
  createdOn?: number;
}

interface Router {
  route(promise: DurablePromise): any;
}
class TagRouter implements Router {
  private tag: string;

  constructor(tag = "resonate:invoke") {
    this.tag = tag;
  }

  route(promise: DurablePromise): any {
    return promise.tags?.[this.tag];
  }
}

export class Server {
  readonly promises: Map<string, DurablePromise>;
  readonly tasks: Map<string, Task>;
  readonly schedules: Map<string, Schedule>;
  private routers: Array<Router>;
  private targets: Record<string, string>;

  constructor() {
    this.promises = new Map();
    this.tasks = new Map();
    this.schedules = new Map();
    this.routers = new Array(new TagRouter());
    this.targets = { default: "local://any@default" };
  }

  next(time: number): number | undefined {
    let timeout: number | undefined = undefined;

    // Check pending promises
    for (const promise of this.promises.values()) {
      if (timeout === 0) {
        return timeout;
      }

      if (promise.state === "pending") {
        timeout = timeout === undefined ? promise.timeout : Math.min(promise.timeout, timeout);
      }
    }

    // Check tasks
    for (const task of this.tasks.values()) {
      if (timeout === 0) {
        return timeout;
      }

      if (task.state === "init") {
        timeout = timeout === undefined ? 0 : Math.min(0, timeout);
      } else if (["claimed", "enqueued"].includes(task.state)) {
        util.assertDefined(task.expiry);
        timeout = timeout === undefined ? task.expiry : Math.min(task.expiry, timeout);
      }
    }

    // Check schedules
    for (const schedule of this.schedules.values()) {
      if (timeout === 0) {
        return timeout;
      }

      util.assertDefined(schedule.nextRunTime);
      timeout = timeout === undefined ? schedule.nextRunTime : Math.min(schedule.nextRunTime, timeout);
    }

    // Convert to delay relative to `time`, clamped to signed 32-bit range
    timeout = timeout !== undefined ? Math.min(Math.max(0, timeout - time), 2147483647) : timeout;

    return timeout;
  }

  step(time: number): { msg: RecvMsg; recv: string }[] {
    for (const schedule of this.schedules.values()) {
      util.assertDefined(schedule.nextRunTime);
      if (time < schedule.nextRunTime) {
        continue;
      }

      try {
        this.createPromise({
          id: schedule.promiseId.replace("{{.timestamp}}", time.toString()),
          timeout: time + schedule.promiseTimeout,
          param: schedule.promiseParam,
          tags: schedule.promiseTags,
          strict: false,
          time,
        });
      } catch {}

      const { applied } = this.transitionSchedule({ id: schedule.id, to: "created", updating: true, time });
      util.assert(applied, `step(): failed to transition schedule '${schedule.id}' to 'created' state`);
    }

    // Reject timed-out promises
    for (const promise of this.promises.values()) {
      if (promise.state === "pending" && time >= promise.timeout) {
        const { applied } = this.transitionPromise({ id: promise.id, to: "rejected_timedout", time: time });
        util.assert(applied, `step(): promise '${promise.id}' expected to be timed out but transition did not apply`);
      }
    }

    // Transition expired tasks back to init
    for (const task of this.tasks.values()) {
      if (["enqueued", "claimed"].includes(task.state)) {
        util.assertDefined(task.expiry);

        if (time >= task.expiry) {
          const { applied } = this.transitionTask({ id: task.id, to: "init", force: true, time });
          util.assert(applied, `step(): failed to force-reinit expired task '${task.id}'`);
        }
      }
    }

    const msgs: { msg: RecvMsg; recv: string }[] = [];

    for (const task of this.tasks.values()) {
      if (task.state !== "init") {
        continue;
      }

      let msg: { msg: RecvMsg; recv: string };
      if (task.type === "invoke") {
        msg = {
          msg: {
            type: "invoke",
            task: {
              id: task.id,
              rootPromiseId: task.rootPromiseId,
              counter: task.counter,
              timeout: this.getPromise({ id: task.rootPromiseId }).timeout,
              processId: task.processId,
              createdOn: task.createdOn,
              completedOn: task.completedOn,
            },
          },
          recv: task.recv,
        };
      } else if (task.type === "resume") {
        msg = {
          msg: {
            type: "resume",
            task: {
              id: task.id,
              rootPromiseId: task.rootPromiseId,
              counter: task.counter,
              timeout: this.getPromise({ id: task.rootPromiseId }).timeout,
              processId: task.processId,
              createdOn: task.createdOn,
              completedOn: task.completedOn,
            },
          },
          recv: task.recv,
        };
      } else {
        util.assert(task.type === "notify", `step(): unexpected task type '${task.type}' for notify message`);
        msg = {
          msg: {
            type: "notify",
            promise: this.getPromise({ id: task.rootPromiseId }),
          },
          recv: task.recv,
        };
      }

      msgs.push(msg);

      if (task.type === "notify") {
        const { applied } = this.transitionTask({ id: task.id, to: "completed", time });
        util.assert(applied, `step(): failed to complete notify task '${task.id}'`);
      } else {
        const { applied } = this.transitionTask({ id: task.id, to: "enqueued", time });
        util.assert(applied, `step(): failed to enqueue task '${task.id}' after invoking/resuming`);
      }
    }

    return msgs;
  }

  process(requ: RequestMsg, time: number): ResponseMsg {
    switch (requ.kind) {
      case "createPromise": {
        return {
          kind: requ.kind,
          promise: this.createPromise({
            id: requ.id,
            timeout: requ.timeout,
            param: requ.param,
            tags: requ.tags,
            iKey: requ.iKey,
            strict: requ.strict,
            time,
          }),
        };
      }
      case "createPromiseAndTask": {
        const { promise, task } = this.createPromiseAndTask({
          id: requ.promise.id,
          timeout: requ.promise.timeout,
          processId: requ.task.processId,
          ttl: requ.task.ttl,
          param: requ.promise.param,
          tags: requ.promise.tags,
          iKey: requ.iKey,
          strict: requ.strict,
          time,
        });
        return {
          kind: requ.kind,
          promise: promise,
          task: task,
        };
      }
      case "readPromise": {
        return {
          kind: requ.kind,
          promise: this.readPromise({ id: requ.id }),
        };
      }

      case "completePromise": {
        return {
          kind: requ.kind,
          promise: this.completePromise({
            id: requ.id,
            state: requ.state,
            value: requ.value,
            iKey: requ.iKey,
            strict: requ.strict,
            time,
          }),
        };
      }

      case "createCallback": {
        return {
          kind: requ.kind,
          ...this.createCallback({
            id: requ.id,
            rootPromiseId: requ.rootPromiseId,
            timeout: requ.timeout,
            recv: requ.recv,
            time,
          }),
        };
      }

      case "createSubscription": {
        return {
          kind: requ.kind,
          ...this.createSubscription({ id: requ.id, timeout: requ.timeout, recv: requ.recv, time }),
        };
      }

      case "createSchedule": {
        return {
          kind: requ.kind,
          schedule: this.createSchedule({
            id: requ.id!,
            cron: requ.cron!,
            promiseId: requ.promiseId!,
            promiseTimeout: requ.promiseTimeout!,
            iKey: requ.iKey,
            description: requ.description,
            tags: requ.tags,
            promiseParam: requ.promiseParam,
            promiseTags: requ.promiseTags,
            time,
          }),
        };
      }

      case "readSchedule": {
        return { kind: requ.kind, schedule: this.readSchedule({ id: requ.id }) };
      }

      case "deleteSchedule": {
        this.deleteSchedule({ id: requ.id, time });
        return { kind: requ.kind };
      }

      case "claimTask": {
        return {
          kind: "claimedtask",
          message: this.claimTask({
            id: requ.id,
            counter: requ.counter,
            processId: requ.processId,
            ttl: requ.ttl,
            time,
          }),
        };
      }

      case "completeTask": {
        return {
          kind: "completedtask",
          task: this.completeTask({ id: requ.id, counter: requ.counter, time }),
        };
      }

      case "heartbeatTasks": {
        return {
          kind: "heartbeatTasks",
          tasksAffected: this.heartbeatTasks({ processId: requ.processId, time }),
        };
      }

      case "dropTask": {
        throw new Error("not implemented");
      }

      default:
        throw new Error(`Unsupported request kind: ${(requ as any).kind}`);
    }
  }

  private _createPromise({
    id,
    timeout,
    param,
    tags,
    iKey,
    strict,
    processId,
    ttl,
    time,
  }: {
    id: string;
    timeout: number;
    param?: any;
    tags?: Record<string, string>;
    iKey?: string;
    strict?: boolean;
    processId?: string;
    ttl?: number;
    time: number;
  }): { promise: DurablePromiseRecord; task?: Task } {
    const { promise, task, applied } = this.transitionPromise({
      id,
      to: "pending",
      strict,
      timeout,
      iKey,
      value: param,
      tags,
      time,
    });

    util.assert(
      !applied || ["pending", "rejected_timedout"].includes(promise.state),
      `createPromise: unexpected promise state '${promise.state}' after transition to 'pending' for promise '${id}'`,
    );

    if (applied && task !== undefined && processId !== undefined) {
      const { task: newTask, applied: appliedTask } = this.transitionTask({
        id: task.id,
        to: "claimed",
        counter: 1,
        processId,
        ttl,
        time,
      });
      util.assert(appliedTask, `createPromise: failed to claim task '${task.id}' for subsequent processing`);
      return { promise: promise, task: newTask };
    }

    return { promise, task };
  }

  private createPromise({
    id,
    timeout,
    param,
    tags,
    iKey,
    strict,
    time,
  }: {
    id: string;
    timeout: number;
    param?: any;
    tags?: Record<string, string>;
    iKey?: string;
    strict?: boolean;
    time: number;
  }): DurablePromiseRecord {
    return this._createPromise({
      id,
      timeout,
      param,
      tags,
      iKey,
      strict,
      time,
    }).promise;
  }

  private createPromiseAndTask({
    id,
    timeout,
    processId,
    ttl,
    param,
    tags,
    iKey,
    strict,
    time,
  }: {
    id: string;
    timeout: number;
    processId: string;
    ttl: number;
    param?: any;
    tags?: Record<string, string>;
    iKey?: string;
    strict?: boolean;
    time: number;
  }): { promise: DurablePromiseRecord; task?: TaskRecord } {
    return this._createPromise({
      id,
      timeout,
      processId,
      ttl,
      param,
      tags,
      iKey,
      strict,
      time,
    }) as {
      promise: DurablePromiseRecord;
      task?: TaskRecord;
    };
  }

  private readPromise({ id }: { id: string }): DurablePromiseRecord {
    return this.getPromise({ id: id });
  }

  private completePromise({
    id,
    state,
    value,
    iKey,
    strict,
    time,
  }: {
    id: string;
    state: "resolved" | "rejected" | "rejected_canceled";
    value?: any;
    iKey?: string;
    strict?: boolean;
    time: number;
  }): DurablePromiseRecord {
    const { promise, applied } = this.transitionPromise({
      id,
      to: state,
      strict,
      iKey,
      value,
      time,
    });
    util.assert(
      !applied || [state, "rejected_timedout"].includes(promise.state),
      `completePromise: after transition to '${state}', promise '${id}' is in unexpected state '${promise.state}'`,
    );
    return promise;
  }

  private createSubscription({
    id,
    timeout,
    recv,
    time,
  }: { id: string; timeout: number; recv: string; time: number }): {
    promise: DurablePromiseRecord;
    callback?: CallbackRecord;
  } {
    {
      const record = this.promises.get(id);

      if (!record) {
        throw new Error("not found");
      }

      const cbId = `__notify:${id}:${id}`;

      if (record.state !== "pending" || record.callbacks?.has(cbId)) {
        return { promise: record, callback: undefined };
      }

      const callback: Callback = {
        id: cbId,
        type: "notify",
        promiseId: id,
        rootPromiseId: id,
        recv,
        timeout,
        createdOn: time,
      };

      if (!record.callbacks) {
        record.callbacks = new Map<string, Callback>();
      }

      // register and return
      record.callbacks.set(cbId, callback);
      return {
        promise: record,
        callback: callback,
      };
    }
  }

  private createCallback({
    id,
    rootPromiseId,
    timeout,
    recv,
    time,
  }: { id: string; rootPromiseId: string; timeout: number; recv: string; time: number }): {
    promise: DurablePromiseRecord;
    callback?: CallbackRecord;
  } {
    const record = this.promises.get(id);

    if (!record) {
      throw new Error("not found");
    }

    if (record.state !== "pending" || record.callbacks?.has(id)) {
      return { promise: record, callback: undefined };
    }

    const callback: Callback = {
      id: `__resume:${rootPromiseId}:${id}`,
      type: "resume",
      promiseId: id,
      rootPromiseId,
      recv,
      timeout,
      createdOn: time,
    };

    if (!record.callbacks) {
      record.callbacks = new Map<string, Callback>();
    }

    record.callbacks.set(callback.id, callback);
    return { promise: record, callback: callback };
  }

  private claimTask({
    id,
    counter,
    processId,
    ttl,
    time,
  }: { id: string; counter: number; processId: string; ttl: number; time: number }): Mesg {
    const { task, applied } = this.transitionTask({
      id,
      to: "claimed",
      counter,
      processId,
      ttl,
      time,
    });

    util.assert(
      applied,
      `claimTask: failed to claim task '${id}' with counter ${counter} using processId '${processId}'`,
    );

    switch (task.type) {
      case "invoke": {
        const promise = this.getPromise({ id: task.rootPromiseId });
        return {
          kind: task.type,
          promises: {
            root: { id: promise.id, data: promise },
          },
        };
      }
      case "resume": {
        return {
          kind: task.type,
          promises: {
            root: {
              id: task.rootPromiseId,
              data: this.getPromise({ id: task.rootPromiseId }),
            },
            leaf: {
              id: task.leafPromiseId,
              data: this.getPromise({ id: task.leafPromiseId }),
            },
          },
        };
      }
      default:
        throw new Error(`claimTask: unexpected task type '${task.type}' for task '${id}'`);
    }
  }

  private completeTask({ id, counter, time }: { id: string; counter: number; time: number }): TaskRecord {
    const { task } = this.transitionTask({ id: id, to: "completed", counter: counter, time: time });

    return {
      id: task.id,
      counter: task.counter,
      rootPromiseId: task.rootPromiseId,
      timeout: 0,
      processId: task.processId,
      createdOn: task.createdOn,
      completedOn: task.completedOn,
    };
  }

  private heartbeatTasks({ processId, time }: { processId: string; time: number }): number {
    let affectedTasks = 0;

    for (const task of this.tasks.values()) {
      if (task.state !== "claimed" || task.processId !== processId) {
        continue;
      }

      const { applied } = this.transitionTask({ id: task.id, to: "claimed", force: true, time: time });

      util.assert(
        applied,
        `heartbeatTasks: failed to refresh heartbeat for task '${task.id}' owned by process '${processId}'`,
      );

      affectedTasks += 1;
    }

    return affectedTasks;
  }

  private createSchedule({
    id,
    cron,
    promiseId,
    promiseTimeout,
    iKey,
    description,
    tags,
    promiseParam,
    promiseTags,
    time,
  }: {
    id: string;
    cron: string;
    promiseId: string;
    promiseTimeout: number;
    iKey?: string;
    description?: string;
    tags?: Record<string, string>;
    promiseParam?: any;
    promiseTags?: Record<string, string>;
    time: number;
  }): ScheduleRecord {
    return this.transitionSchedule({
      id,
      to: "created",
      cron,
      promiseId,
      promiseTimeout,
      iKey,
      description,
      tags,
      promiseParam,
      promiseTags,
      time,
    }).schedule;
  }

  private readSchedule({ id }: { id: string }): ScheduleRecord {
    const schedule = this.schedules.get(id);
    if (schedule === undefined) {
      throw new Error("schedule not found");
    }
    return schedule;
  }

  private deleteSchedule({ id, time }: { id: string; time: number }): void {
    const { applied } = this.transitionSchedule({ id: id, to: "deleted", time: time });

    util.assert(applied, `deleteSchedule: failed to delete schedule '${id}'`);
  }

  private getPromise({ id }: { id: string }): DurablePromise {
    const record = this.promises.get(id);

    if (!record) {
      throw new Error("not found");
    }

    return record;
  }

  private transitionPromise({
    id,
    to,
    strict,
    timeout,
    iKey,
    value,
    tags,
    time,
  }: {
    id: string;
    to: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
    strict?: boolean;
    timeout?: number;
    iKey?: string;
    value?: any;
    tags?: Record<string, string>;
    time: number;
  }): { promise: DurablePromise; task?: Task; applied: boolean } {
    const { promise, applied } = this._transitionPromise({
      id,
      to,
      strict,
      timeout,
      iKey,
      value,
      tags,
      time,
    });

    // Initialize invocation tasks on pending
    if (applied && promise.state === "pending") {
      for (const router of this.routers) {
        const recv = router.route(promise);
        if (recv !== undefined) {
          const { task, applied: taskApplied } = this.transitionTask({
            id: `__invoke:${id}`,
            to: "init",
            type: "invoke",
            recv: this.targets[recv] ?? recv,
            rootPromiseId: promise.id,
            leafPromiseId: promise.id,
            time,
          });
          util.assert(
            taskApplied,
            `transitionPromise: failed to init invoke task for promise '${id}' on route '${recv}'`,
          );
          return { promise, task, applied: taskApplied };
        }
      }
    }

    // Complete any tasks and schedule callbacks after resolution
    if (applied && ["resolved", "rejected", "rejected_canceled", "rejected_timedout"].includes(promise.state)) {
      // Mark existing tasks as completed
      for (const task of this.tasks.values()) {
        if (task.rootPromiseId === id && ["init", "enqueued", "claimed"].includes(task.state)) {
          const { applied: completeApplied } = this.transitionTask({
            id: task.id,
            to: "completed",
            force: true,
            time,
          });
          util.assert(completeApplied, `transitionPromise: failed to complete task '${task.id}' for promise '${id}'`);
        }
      }

      // Initialize callback tasks
      if (promise.callbacks) {
        for (const callback of promise.callbacks.values()) {
          const { applied: callbackApplied } = this.transitionTask({
            id: callback.id,
            to: "init",
            type: callback.type,
            recv: callback.recv,
            rootPromiseId: callback.rootPromiseId,
            leafPromiseId: callback.promiseId,
            time: time,
          });
          util.assert(
            callbackApplied,
            `transitionPromise: failed to init callback task '${callback.id}' for promise '${id}'`,
          );
        }
        promise.callbacks.clear();
      }
    }

    return { promise, applied };
  }

  private _transitionPromise({
    id,
    to,
    strict,
    timeout,
    iKey,
    value,
    tags,
    time,
  }: {
    id: string;
    to: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
    strict?: boolean;
    timeout?: number;
    iKey?: string;
    value?: any;
    tags?: Record<string, string>;
    time: number;
  }): { promise: DurablePromise; applied: boolean } {
    let record = this.promises.get(id);

    // Create new promise
    if (record === undefined && to === "pending") {
      util.assertDefined(timeout);
      record = {
        id,
        state: to,
        timeout,
        iKeyForCreate: iKey,
        param: value,
        value: undefined,
        tags: tags ?? {},
        createdOn: time,
      };

      this.promises.set(id, record);
      return { promise: record, applied: true };
    }

    // Cannot complete non-existent promise
    if (record === undefined && ["resolved", "rejected", "rejected_canceled"].includes(to)) {
      throw new Error(`transitionPromise(${to}): promise '${id}' not found`);
    }

    // No-op re-create pending if before timeout and same iKey
    if (
      record?.state === "pending" &&
      to === "pending" &&
      time < record.timeout &&
      ikeyMatch(record.iKeyForCreate, iKey)
    ) {
      return { promise: record, applied: false };
    }

    // Auto-timeout transition
    if (
      record?.state === "pending" &&
      to === "pending" &&
      !strict &&
      time >= record.timeout &&
      ikeyMatch(record.iKeyForCreate, iKey)
    ) {
      return this._transitionPromise({ id: id, to: "rejected_timedout", time: time });
    }

    // Resolve or reject before timeout
    if (
      record?.state === "pending" &&
      ["resolved", "rejected", "rejected_canceled"].includes(to) &&
      time < record.timeout
    ) {
      record = {
        ...record,
        state: to,
        iKeyForComplete: iKey,
        value: value,
        completedOn: time,
      };

      this.promises.set(id, record);
      return { promise: record, applied: true };
    }

    // Attempt completion after timeout without strict -> treat as timeout
    if (
      record?.state === "pending" &&
      ["resolved", "rejected", "rejected_canceled"].includes(to) &&
      !strict &&
      time >= record.timeout
    ) {
      return this._transitionPromise({ id: id, to: "rejected_timedout", time: time });
    }

    // Strict completion after timeout -> error
    if (
      record?.state === "pending" &&
      ["resolved", "rejected", "rejected_canceled"].includes(to) &&
      strict &&
      time >= record.timeout
    ) {
      throw new Error(`transitionPromise(${to}): promise '${id}' already timed out at ${record.timeout}`);
    }

    // Transition to timed-out
    if (record?.state === "pending" && to === "rejected_timedout") {
      util.assert(
        time >= record.timeout,
        `transitionPromise(rejected_timedout): cannot time out promise '${id}' before its timeout (${record.timeout})`,
      );

      record = {
        ...record,
        state: record.tags?.["resonate:timeout"] === "true" ? "resolved" : to,
      };

      this.promises.set(id, record);
      return { promise: record, applied: true };
    }

    // No-op re-pending or re-completing without strict and matching iKey
    if (
      record?.state !== undefined &&
      ["resolved", "rejected", "rejected_canceled", "rejected_timedout"].includes(record.state) &&
      to === "pending" &&
      !strict &&
      ikeyMatch(record.iKeyForCreate, iKey)
    ) {
      return { promise: record, applied: false };
    }

    if (
      record !== undefined &&
      ["resolved", "rejected", "rejected_canceled"].includes(record.state) &&
      ["resolved", "rejected", "rejected_canceled"].includes(to) &&
      !strict &&
      ikeyMatch(record.iKeyForComplete, iKey)
    ) {
      return { promise: record, applied: false };
    }

    if (
      record?.state === "rejected_timedout" &&
      ["resolved", "rejected", "rejected_canceled"].includes(to) &&
      !strict
    ) {
      return { promise: record, applied: false };
    }

    if (
      record !== undefined &&
      ["resolved", "rejected", "rejected_canceled"].includes(record.state) &&
      ["resolved", "rejected", "rejected_canceled"].includes(to) &&
      strict &&
      ikeyMatch(record.iKeyForComplete, iKey) &&
      record.state === to
    ) {
      return { promise: record, applied: false };
    }

    // Fallback
    throw new Error(`transitionPromise(${to}): unexpected transition for promise '${id}'`);
  }

  private transitionTask({
    id,
    to,
    type,
    recv,
    rootPromiseId,
    leafPromiseId,
    counter,
    processId,
    ttl,
    force,
    time,
  }: {
    id: string;
    to: "init" | "enqueued" | "claimed" | "completed";
    type?: "invoke" | "resume" | "notify";
    recv?: string;
    rootPromiseId?: string;
    leafPromiseId?: string;
    counter?: number;
    processId?: string;
    ttl?: number;
    force?: boolean;
    time: number;
  }): { task: Task; applied: boolean } {
    let record = this.tasks.get(id);

    if (record === undefined && to === "init") {
      util.assertDefined(type);
      util.assertDefined(recv);
      util.assertDefined(rootPromiseId);
      util.assertDefined(leafPromiseId);

      record = {
        id,
        counter: 1,
        state: to,
        type,
        recv,
        rootPromiseId,
        leafPromiseId,
        createdOn: time,
      };
      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "init" && to === "enqueued") {
      record = {
        ...record,
        state: to,
        expiry: time + 5000,
      };
      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "init" && to === "claimed" && record.counter === counter) {
      util.assertDefined(ttl);
      util.assertDefined(processId);

      record = {
        ...record,
        state: to,
        processId,
        ttl,
        expiry: time + ttl,
      };

      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "enqueued" && to === "claimed" && record.counter === counter) {
      util.assertDefined(ttl);
      util.assertDefined(processId);

      record = {
        ...record,
        state: to,
        processId,
        ttl,
        expiry: time + ttl,
      };

      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (
      record !== undefined &&
      ["init", "enqueued"].includes(record.state) &&
      record.type === "notify" &&
      to === "completed"
    ) {
      record = {
        ...record,
        state: to,
        completedOn: time,
      };

      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (record !== undefined && ["enqueued", "claimed"].includes(record.state) && to === "init") {
      util.assertDefined(record.expiry);
      util.assert(
        time >= record.expiry,
        `transitionTask(init): cannot re-init task '${id}' before expiry (${record.expiry})`,
      );

      record = {
        ...record,
        counter: record.counter + 1,
        state: to,
      };

      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "claimed" && to === "claimed" && force) {
      util.assertDefined(record.ttl);

      record = {
        ...record,
        processId: record.processId,
        ttl: record.ttl,
        expiry: time + record.ttl,
      };

      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (
      record?.state === "claimed" &&
      to === "completed" &&
      record.counter === counter &&
      record.expiry !== undefined &&
      record.expiry >= time
    ) {
      record = {
        ...record,
        state: to,
        completedOn: time,
      };

      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (
      record !== undefined &&
      ["init", "enqueued", "claimed"].includes(record?.state) &&
      to === "completed" &&
      force
    ) {
      record = {
        ...record,
        state: to,
      };

      this.tasks.set(id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "completed" && to === "completed") {
      return { task: record, applied: false };
    }

    if (record === undefined) {
      throw new Error("Task not found");
    }

    throw new Error("task is already claimed, completed, or an invalid counter was provided");
  }

  private transitionSchedule({
    id,
    to,
    cron,
    promiseId,
    promiseTimeout,
    iKey,
    description,
    tags,
    promiseParam,
    promiseTags,
    updating,
    time,
  }: {
    id: string;
    to: "created" | "deleted";
    cron?: string;
    promiseId?: string;
    promiseTimeout?: number;
    iKey?: string;
    description?: string;
    tags?: Record<string, string>;
    promiseParam?: any;
    promiseTags?: Record<string, string>;
    updating?: boolean;
    time: number;
  }): { schedule: Schedule; applied: boolean } {
    let record = this.schedules.get(id);

    // Create new schedule
    if (record === undefined && to === "created") {
      util.assertDefined(cron);
      util.assertDefined(promiseId);
      util.assertDefined(promiseTimeout);
      util.assert(promiseTimeout >= 0, "transitionSchedule(created): 'promiseTimeout' must be non-negative");

      record = {
        id,
        description,
        cron,
        tags: tags ?? {},
        promiseId,
        promiseTimeout,
        promiseParam,
        promiseTags: promiseTags ?? {},
        lastRunTime: undefined,
        nextRunTime: CronExpressionParser.parse(cron).next().getMilliseconds(),
        iKey,
        createdOn: time,
      };
      this.schedules.set(id, record);
      return { schedule: record, applied: true };
    }

    // No-op if same iKey
    if (record !== undefined && to === "created" && ikeyMatch(iKey, record.iKey)) {
      return { schedule: record, applied: false };
    }

    // Update existing schedule
    if (record !== undefined && to === "created" && updating) {
      record = {
        ...record,
        lastRunTime: record.nextRunTime,
        nextRunTime: CronExpressionParser.parse(record.cron).next().getMilliseconds(),
      };
      this.schedules.set(id, record);
      return { schedule: record, applied: true };
    }

    // Schedule exists and not updating
    if (record !== undefined && to === "created") {
      throw new Error(`transitionSchedule(created): schedule '${id}' already exists and 'updating' flag is false`);
    }

    // Delete non-existent
    if (record === undefined && to === "deleted") {
      throw new Error(`transitionSchedule(deleted): schedule '${id}' not found`);
    }

    // Delete existing
    if (record !== undefined && to === "deleted") {
      this.schedules.delete(id);
      return { schedule: record, applied: true };
    }

    // Fallback error
    throw new Error(`transitionSchedule(${to}): unexpected transition for schedule '${id}'`);
  }
}

function ikeyMatch(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left === right;
}
