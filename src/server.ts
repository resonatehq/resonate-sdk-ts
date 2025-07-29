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
  private promises: Map<string, DurablePromise>;
  private tasks: Map<string, Task>;
  private schedules: Map<string, Schedule>;
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

  private _createPromise(args: {
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
      id: args.id,
      to: "pending",
      strict: args.strict,
      timeout: args.timeout,
      iKey: args.iKey,
      value: args.param,
      tags: args.tags,
      time: args.time,
    });

    util.assert(
      !applied || ["pending", "rejected_timedout"].includes(promise.state),
      `createPromise: unexpected promise state '${promise.state}' after transition to 'pending' for promise '${args.id}'`,
    );

    if (applied && task !== undefined && args.processId !== undefined) {
      const { task: newTask, applied: appliedTask } = this.transitionTask({
        id: task.id,
        to: "claimed",
        counter: 1,
        processId: args.processId,
        ttl: args.ttl,
        time: args.time,
      });
      util.assert(appliedTask, `createPromise: failed to claim task '${task.id}' for subsequent processing`);
      return { promise: promise, task: newTask };
    }

    return { promise, task };
  }

  private createPromise(args: {
    id: string;
    timeout: number;
    param?: any;
    tags?: Record<string, string>;
    iKey?: string;
    strict?: boolean;
    time: number;
  }): DurablePromiseRecord {
    return this._createPromise({
      id: args.id,
      timeout: args.timeout,
      param: args.param,
      tags: args.tags,
      iKey: args.iKey,
      strict: args.strict,
      time: args.time,
    }).promise;
  }

  private createPromiseAndTask(args: {
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
      id: args.id,
      timeout: args.timeout,
      processId: args.processId,
      ttl: args.ttl,
      param: args.param,
      tags: args.tags,
      iKey: args.iKey,
      strict: args.strict,
      time: args.time,
    }) as {
      promise: DurablePromiseRecord;
      task?: TaskRecord;
    };
  }

  private readPromise(args: { id: string }): DurablePromiseRecord {
    return this.getPromise({ id: args.id });
  }

  private completePromise(args: {
    id: string;
    state: "resolved" | "rejected" | "rejected_canceled";
    value?: any;
    iKey?: string;
    strict?: boolean;
    time: number;
  }): DurablePromiseRecord {
    const { promise, applied } = this.transitionPromise({
      id: args.id,
      to: args.state,
      strict: args.strict,
      iKey: args.iKey,
      value: args.value,
      time: args.time,
    });
    util.assert(
      !applied || [args.state, "rejected_timedout"].includes(promise.state),
      `completePromise: after transition to '${args.state}', promise '${args.id}' is in unexpected state '${promise.state}'`,
    );
    return promise;
  }

  private createSubscription(args: { id: string; timeout: number; recv: string; time: number }): {
    promise: DurablePromiseRecord;
    callback?: CallbackRecord;
  } {
    {
      const record = this.promises.get(args.id);

      if (!record) {
        throw new Error("not found");
      }

      const cbId = `__notify:${args.id}:${args.id}`;

      if (record.state !== "pending" || record.callbacks?.has(cbId)) {
        return { promise: record, callback: undefined };
      }

      const callback: Callback = {
        id: cbId,
        type: "notify",
        promiseId: args.id,
        rootPromiseId: args.id,
        recv: args.recv,
        timeout: args.timeout,
        createdOn: args.time,
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

  private createCallback(args: { id: string; rootPromiseId: string; timeout: number; recv: string; time: number }): {
    promise: DurablePromiseRecord;
    callback?: CallbackRecord;
  } {
    const record = this.promises.get(args.id);

    if (!record) {
      throw new Error("not found");
    }

    if (record.state !== "pending" || record.callbacks?.has(args.id)) {
      return { promise: record, callback: undefined };
    }

    const callback: Callback = {
      id: `__resume:${args.rootPromiseId}:${args.id}`,
      type: "resume",
      promiseId: args.id,
      rootPromiseId: args.rootPromiseId,
      recv: args.recv,
      timeout: args.timeout,
      createdOn: args.time,
    };

    if (!record.callbacks) {
      record.callbacks = new Map<string, Callback>();
    }

    record.callbacks.set(callback.id, callback);
    return { promise: record, callback: callback };
  }

  private claimTask(args: { id: string; counter: number; processId: string; ttl: number; time: number }): Mesg {
    const { task, applied } = this.transitionTask({
      id: args.id,
      to: "claimed",
      counter: args.counter,
      processId: args.processId,
      ttl: args.ttl,
      time: args.time,
    });

    util.assert(
      applied,
      `claimTask: failed to claim task '${args.id}' with counter ${args.counter} using processId '${args.processId}'`,
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
        throw new Error(`claimTask: unexpected task type '${task.type}' for task '${args.id}'`);
    }
  }

  private completeTask(args: { id: string; counter: number; time: number }): TaskRecord {
    const { task } = this.transitionTask({ id: args.id, to: "completed", counter: args.counter, time: args.time });

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

  private heartbeatTasks(args: { processId: string; time: number }): number {
    let affectedTasks = 0;

    for (const task of this.tasks.values()) {
      if (task.state !== "claimed" || task.processId !== args.processId) {
        continue;
      }

      const { applied } = this.transitionTask({ id: task.id, to: "claimed", force: true, time: args.time });

      util.assert(
        applied,
        `heartbeatTasks: failed to refresh heartbeat for task '${task.id}' owned by process '${args.processId}'`,
      );

      affectedTasks += 1;
    }

    return affectedTasks;
  }

  private createSchedule(args: {
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
      id: args.id,
      to: "created",
      cron: args.cron,
      promiseId: args.promiseId,
      promiseTimeout: args.promiseTimeout,
      iKey: args.iKey,
      description: args.description,
      tags: args.tags,
      promiseParam: args.promiseParam,
      promiseTags: args.promiseTags,
      time: args.time,
    }).schedule;
  }

  private readSchedule(args: { id: string }): ScheduleRecord {
    const schedule = this.schedules.get(args.id);
    if (schedule === undefined) {
      throw new Error("schedule not found");
    }
    return schedule;
  }

  private deleteSchedule(args: { id: string; time: number }): void {
    const { applied } = this.transitionSchedule({ id: args.id, to: "deleted", time: args.time });

    util.assert(applied, `deleteSchedule: failed to delete schedule '${args.id}'`);
  }

  private getPromise(args: { id: string }): DurablePromise {
    const record = this.promises.get(args.id);

    if (!record) {
      throw new Error("not found");
    }

    return record;
  }

  private transitionPromise(args: {
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
      id: args.id,
      to: args.to,
      strict: args.strict,
      timeout: args.timeout,
      iKey: args.iKey,
      value: args.value,
      tags: args.tags,
      time: args.time,
    });

    // Initialize invocation tasks on pending
    if (applied && promise.state === "pending") {
      for (const router of this.routers) {
        const recv = router.route(promise);
        if (recv !== undefined) {
          const { task, applied: taskApplied } = this.transitionTask({
            id: `__invoke:${args.id}`,
            to: "init",
            type: "invoke",
            recv: this.targets[recv] ?? recv,
            rootPromiseId: promise.id,
            leafPromiseId: promise.id,
            time: args.time,
          });
          util.assert(
            taskApplied,
            `transitionPromise: failed to init invoke task for promise '${args.id}' on route '${recv}'`,
          );
          return { promise, task, applied: taskApplied };
        }
      }
    }

    // Complete any tasks and schedule callbacks after resolution
    if (applied && ["resolved", "rejected", "rejected_canceled", "rejected_timedout"].includes(promise.state)) {
      // Mark existing tasks as completed
      for (const task of this.tasks.values()) {
        if (task.rootPromiseId === args.id && ["init", "enqueued", "claimed"].includes(task.state)) {
          const { applied: completeApplied } = this.transitionTask({
            id: task.id,
            to: "completed",
            force: true,
            time: args.time,
          });
          util.assert(
            completeApplied,
            `transitionPromise: failed to complete task '${task.id}' for promise '${args.id}'`,
          );
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
            time: args.time,
          });
          util.assert(
            callbackApplied,
            `transitionPromise: failed to init callback task '${callback.id}' for promise '${args.id}'`,
          );
        }
        promise.callbacks.clear();
      }
    }

    return { promise, applied };
  }

  private _transitionPromise(args: {
    id: string;
    to: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
    strict?: boolean;
    timeout?: number;
    iKey?: string;
    value?: any;
    tags?: Record<string, string>;
    time: number;
  }): { promise: DurablePromise; applied: boolean } {
    let record = this.promises.get(args.id);

    // Create new promise
    if (record === undefined && args.to === "pending") {
      util.assertDefined(args.timeout);
      record = {
        id: args.id,
        state: args.to,
        timeout: args.timeout,
        iKeyForCreate: args.iKey,
        param: args.value,
        value: undefined,
        tags: args.tags ?? {},
        createdOn: args.time,
      };

      this.promises.set(args.id, record);
      return { promise: record, applied: true };
    }

    // Cannot complete non-existent promise
    if (record === undefined && ["resolved", "rejected", "rejected_canceled"].includes(args.to)) {
      throw new Error(`transitionPromise(${args.to}): promise '${args.id}' not found`);
    }

    // No-op re-create pending if before timeout and same iKey
    if (
      record?.state === "pending" &&
      args.to === "pending" &&
      args.time < record.timeout &&
      ikeyMatch(record.iKeyForCreate, args.iKey)
    ) {
      return { promise: record, applied: false };
    }

    // Auto-timeout transition
    if (
      record?.state === "pending" &&
      args.to === "pending" &&
      !args.strict &&
      args.time >= record.timeout &&
      ikeyMatch(record.iKeyForCreate, args.iKey)
    ) {
      return this._transitionPromise({ id: args.id, to: "rejected_timedout", time: args.time });
    }

    // Resolve or reject before timeout
    if (
      record?.state === "pending" &&
      ["resolved", "rejected", "rejected_canceled"].includes(args.to) &&
      args.time < record.timeout
    ) {
      record = {
        ...record,
        state: args.to,
        iKeyForComplete: args.iKey,
        value: args.value,
        completedOn: args.time,
      };

      this.promises.set(args.id, record);
      return { promise: record, applied: true };
    }

    // Attempt completion after timeout without strict -> treat as timeout
    if (
      record?.state === "pending" &&
      ["resolved", "rejected", "rejected_canceled"].includes(args.to) &&
      !args.strict &&
      args.time >= record.timeout
    ) {
      return this._transitionPromise({ id: args.id, to: "rejected_timedout", time: args.time });
    }

    // Strict completion after timeout -> error
    if (
      record?.state === "pending" &&
      ["resolved", "rejected", "rejected_canceled"].includes(args.to) &&
      args.strict &&
      args.time >= record.timeout
    ) {
      throw new Error(`transitionPromise(${args.to}): promise '${args.id}' already timed out at ${record.timeout}`);
    }

    // Transition to timed-out
    if (record?.state === "pending" && args.to === "rejected_timedout") {
      util.assert(
        args.time >= record.timeout,
        `transitionPromise(rejected_timedout): cannot time out promise '${args.id}' before its timeout (${record.timeout})`,
      );

      record = {
        ...record,
        state: record.tags?.["resonate:timeout"] === "true" ? "resolved" : args.to,
      };

      this.promises.set(args.id, record);
      return { promise: record, applied: true };
    }

    // No-op re-pending or re-completing without strict and matching iKey
    if (
      record?.state !== undefined &&
      ["resolved", "rejected", "rejected_canceled", "rejected_timedout"].includes(record.state) &&
      args.to === "pending" &&
      !args.strict &&
      ikeyMatch(record.iKeyForCreate, args.iKey)
    ) {
      return { promise: record, applied: false };
    }

    if (
      record !== undefined &&
      ["resolved", "rejected", "rejected_canceled"].includes(record.state) &&
      ["resolved", "rejected", "rejected_canceled"].includes(args.to) &&
      !args.strict &&
      ikeyMatch(record.iKeyForComplete, args.iKey)
    ) {
      return { promise: record, applied: false };
    }

    if (
      record?.state === "rejected_timedout" &&
      ["resolved", "rejected", "rejected_canceled"].includes(args.to) &&
      !args.strict
    ) {
      return { promise: record, applied: false };
    }

    if (
      record !== undefined &&
      ["resolved", "rejected", "rejected_canceled"].includes(record.state) &&
      ["resolved", "rejected", "rejected_canceled"].includes(args.to) &&
      args.strict &&
      ikeyMatch(record.iKeyForComplete, args.iKey) &&
      record.state === args.to
    ) {
      return { promise: record, applied: false };
    }

    // Fallback
    throw new Error(`transitionPromise(${args.to}): unexpected transition for promise '${args.id}'`);
  }

  private transitionTask(args: {
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
    let record = this.tasks.get(args.id);

    if (record === undefined && args.to === "init") {
      util.assertDefined(args.type);
      util.assertDefined(args.recv);
      util.assertDefined(args.rootPromiseId);
      util.assertDefined(args.leafPromiseId);

      record = {
        id: args.id,
        counter: 1,
        state: args.to,
        type: args.type,
        recv: args.recv,
        rootPromiseId: args.rootPromiseId,
        leafPromiseId: args.leafPromiseId,
        createdOn: args.time,
      };
      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "init" && args.to === "enqueued") {
      record = {
        ...record,
        state: args.to,
        expiry: args.time + 5000,
      };
      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "init" && args.to === "claimed" && record.counter === args.counter) {
      util.assertDefined(args.ttl);
      util.assertDefined(args.processId);

      record = {
        ...record,
        state: args.to,
        processId: args.processId,
        ttl: args.ttl,
        expiry: args.time + args.ttl,
      };

      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "enqueued" && args.to === "claimed" && record.counter === args.counter) {
      util.assertDefined(args.ttl);
      util.assertDefined(args.processId);

      record = {
        ...record,
        state: args.to,
        processId: args.processId,
        ttl: args.ttl,
        expiry: args.time + args.ttl,
      };

      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (
      record !== undefined &&
      ["init", "enqueued"].includes(record.state) &&
      record.type === "notify" &&
      args.to === "completed"
    ) {
      record = {
        ...record,
        state: args.to,
        completedOn: args.time,
      };

      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (record !== undefined && ["enqueued", "claimed"].includes(record.state) && args.to === "init") {
      util.assertDefined(record.expiry);
      util.assert(
        args.time >= record.expiry,
        `transitionTask(init): cannot re-init task '${args.id}' before expiry (${record.expiry})`,
      );

      record = {
        ...record,
        counter: record.counter + 1,
        state: args.to,
      };

      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "claimed" && args.to === "claimed" && args.force) {
      util.assertDefined(record.ttl);

      record = {
        ...record,
        processId: record.processId,
        ttl: record.ttl,
        expiry: args.time + record.ttl,
      };

      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (
      record?.state === "claimed" &&
      args.to === "completed" &&
      record.counter === args.counter &&
      record.expiry !== undefined &&
      record.expiry >= args.time
    ) {
      record = {
        ...record,
        state: args.to,
        completedOn: args.time,
      };

      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (
      record !== undefined &&
      ["init", "enqueued", "claimed"].includes(record?.state) &&
      args.to === "completed" &&
      args.force
    ) {
      record = {
        ...record,
        state: args.to,
      };

      this.tasks.set(args.id, record);
      return { task: record, applied: true };
    }

    if (record?.state === "completed" && args.to === "completed") {
      return { task: record, applied: false };
    }

    if (record === undefined) {
      throw new Error("Task not found");
    }

    throw new Error("task is already claimed, completed, or an invalid counter was provided");
  }

  private transitionSchedule(args: {
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
    let record = this.schedules.get(args.id);

    // Create new schedule
    if (record === undefined && args.to === "created") {
      util.assertDefined(args.cron);
      util.assertDefined(args.promiseId);
      util.assertDefined(args.promiseTimeout);
      util.assert(args.promiseTimeout >= 0, "transitionSchedule(created): 'promiseTimeout' must be non-negative");

      record = {
        id: args.id,
        description: args.description,
        cron: args.cron,
        tags: args.tags ?? {},
        promiseId: args.promiseId,
        promiseTimeout: args.promiseTimeout,
        promiseParam: args.promiseParam,
        promiseTags: args.promiseTags ?? {},
        lastRunTime: undefined,
        nextRunTime: CronExpressionParser.parse(args.cron).next().getMilliseconds(),
        iKey: args.iKey,
        createdOn: args.time,
      };
      this.schedules.set(args.id, record);
      return { schedule: record, applied: true };
    }

    // No-op if same iKey
    if (record !== undefined && args.to === "created" && ikeyMatch(args.iKey, record.iKey)) {
      return { schedule: record, applied: false };
    }

    // Update existing schedule
    if (record !== undefined && args.to === "created" && args.updating) {
      record = {
        ...record,
        lastRunTime: record.nextRunTime,
        nextRunTime: CronExpressionParser.parse(record.cron).next().getMilliseconds(),
      };
      this.schedules.set(args.id, record);
      return { schedule: record, applied: true };
    }

    // Schedule exists and not updating
    if (record !== undefined && args.to === "created") {
      throw new Error(`transitionSchedule(created): schedule '${args.id}' already exists and 'updating' flag is false`);
    }

    // Delete non-existent
    if (record === undefined && args.to === "deleted") {
      throw new Error(`transitionSchedule(deleted): schedule '${args.id}' not found`);
    }

    // Delete existing
    if (record !== undefined && args.to === "deleted") {
      this.schedules.delete(args.id);
      return { schedule: record, applied: true };
    }

    // Fallback error
    throw new Error(`transitionSchedule(${args.to}): unexpected transition for schedule '${args.id}'`);
  }
}

function ikeyMatch(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left === right;
}
