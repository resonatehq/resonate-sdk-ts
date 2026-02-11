// =============================================================================
// SHARED TYPES
// =============================================================================

export type Value = {
  headers?: Record<string, string>;
  data?: string;
};

// =============================================================================
// RECORDS
// =============================================================================

export type PromiseRecord = {
  id: string;
  state: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
  param: Value;
  value: Value;
  tags: Record<string, string>;
  timeoutAt: number;
  createdAt: number;
  settledAt?: number;
};

export type TaskRecord = {
  id: string;
  state: "pending" | "acquired" | "suspended" | "fulfilled";
  version: number;
};

export type ScheduleRecord = {
  id: string;
  cron: string;
  promiseId: string;
  promiseTimeout: number;
  promiseParam: Value;
  promiseTags: Record<string, string>;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
};

// =============================================================================
// REQUEST HEAD
// =============================================================================

export type RequestHead = {
  auth?: string;
  corrId: string;
  version: string;
};

// =============================================================================
// REQUESTS - PROMISE
// =============================================================================

export type PromiseGetReq = {
  kind: "promise.get";
  head: RequestHead;
  data: { id: string };
};

export type PromiseCreateReq = {
  kind: "promise.create";
  head: RequestHead;
  data: {
    id: string;
    timeoutAt: number;
    param: Value;
    tags: Record<string, string>;
  };
};

export type PromiseSettleReq = {
  kind: "promise.settle";
  head: RequestHead;
  data: {
    id: string;
    state: "resolved" | "rejected" | "rejected_canceled";
    value: Value;
  };
};

export type PromiseRegisterReq = {
  kind: "promise.register";
  head: RequestHead;
  data: {
    awaited: string;
    awaiter: string;
  };
};

export type PromiseSubscribeReq = {
  kind: "promise.subscribe";
  head: RequestHead;
  data: {
    awaited: string;
    address: string;
  };
};

// =============================================================================
// REQUESTS - TASK
// =============================================================================

export type TaskGetReq = {
  kind: "task.get";
  head: RequestHead;
  data: { id: string };
};

export type TaskCreateReq = {
  kind: "task.create";
  head: RequestHead;
  data: {
    pid: string;
    ttl: number;
    action: PromiseCreateReq;
  };
};

export type TaskAcquireReq = {
  kind: "task.acquire";
  head: RequestHead;
  data: {
    id: string;
    version: number;
    pid: string;
    ttl: number;
  };
};

export type TaskSuspendReq = {
  kind: "task.suspend";
  head: RequestHead;
  data: {
    id: string;
    version: number;
    actions: PromiseRegisterReq[];
  };
};

export type TaskFulfillReq = {
  kind: "task.fulfill";
  head: RequestHead;
  data: {
    id: string;
    version: number;
    action: PromiseSettleReq;
  };
};

export type TaskReleaseReq = {
  kind: "task.release";
  head: RequestHead;
  data: {
    id: string;
    version: number;
  };
};

export type TaskFenceReq = {
  kind: "task.fence";
  head: RequestHead;
  data: {
    id: string;
    version: number;
    action: PromiseCreateReq | PromiseSettleReq;
  };
};

export type TaskHeartbeatReq = {
  kind: "task.heartbeat";
  head: RequestHead;
  data: {
    pid: string;
    tasks: { id: string; version: number }[];
  };
};

// =============================================================================
// REQUESTS - SCHEDULE
// =============================================================================

export type ScheduleGetReq = {
  kind: "schedule.get";
  head: RequestHead;
  data: { id: string };
};

export type ScheduleCreateReq = {
  kind: "schedule.create";
  head: RequestHead;
  data: {
    id: string;
    cron: string;
    promiseId: string;
    promiseTimeout: number;
    promiseParam: Value;
    promiseTags: Record<string, string>;
  };
};

export type ScheduleDeleteReq = {
  kind: "schedule.delete";
  head: RequestHead;
  data: { id: string };
};

// =============================================================================
// REQUESTS - DEBUG
// =============================================================================

export type DebugStartReq = {
  kind: "debug.start";
  head: RequestHead;
  data: Record<string, never>;
};

export type DebugResetReq = {
  kind: "debug.reset";
  head: RequestHead;
  data: Record<string, never>;
};

export type DebugTickReq = {
  kind: "debug.tick";
  head: RequestHead;
  data: { time: number };
};

export type DebugSnapReq = {
  kind: "debug.snap";
  head: RequestHead;
  data: Record<string, never>;
};

export type DebugStopReq = {
  kind: "debug.stop";
  head: RequestHead;
  data: Record<string, never>;
};

// =============================================================================
// REQUEST UNION
// =============================================================================

export type Request =
  | PromiseGetReq
  | PromiseCreateReq
  | PromiseSettleReq
  | PromiseRegisterReq
  | PromiseSubscribeReq
  | TaskGetReq
  | TaskCreateReq
  | TaskAcquireReq
  | TaskSuspendReq
  | TaskFulfillReq
  | TaskReleaseReq
  | TaskFenceReq
  | TaskHeartbeatReq
  | ScheduleGetReq
  | ScheduleCreateReq
  | ScheduleDeleteReq
  | DebugStartReq
  | DebugResetReq
  | DebugTickReq
  | DebugSnapReq
  | DebugStopReq;

// =============================================================================
// RESPONSE HEAD
// =============================================================================

export type ResponseHead<S extends number> = {
  corrId: string;
  status: S;
  version: string;
};

// =============================================================================
// RESPONSES - PROMISE
// =============================================================================

export type PromiseGetRes =
  | { kind: "promise.get"; head: ResponseHead<200>; data: { promise: PromiseRecord } }
  | { kind: "promise.get"; head: ResponseHead<400>; data: string }
  | { kind: "promise.get"; head: ResponseHead<404>; data: string }
  | { kind: "promise.get"; head: ResponseHead<429>; data: string }
  | { kind: "promise.get"; head: ResponseHead<500>; data: string };
export type PromiseGetRes200 = Extract<PromiseGetRes, { head: { status: 200 } }>;
export type PromiseGetRes400 = Extract<PromiseGetRes, { head: { status: 400 } }>;
export type PromiseGetRes404 = Extract<PromiseGetRes, { head: { status: 404 } }>;
export type PromiseGetRes429 = Extract<PromiseGetRes, { head: { status: 429 } }>;
export type PromiseGetRes500 = Extract<PromiseGetRes, { head: { status: 500 } }>;

export type PromiseCreateRes =
  | { kind: "promise.create"; head: ResponseHead<200>; data: { promise: PromiseRecord } }
  | { kind: "promise.create"; head: ResponseHead<400>; data: string }
  | { kind: "promise.create"; head: ResponseHead<429>; data: string }
  | { kind: "promise.create"; head: ResponseHead<500>; data: string };
export type PromiseCreateRes200 = Extract<PromiseCreateRes, { head: { status: 200 } }>;
export type PromiseCreateRes400 = Extract<PromiseCreateRes, { head: { status: 400 } }>;
export type PromiseCreateRes429 = Extract<PromiseCreateRes, { head: { status: 429 } }>;
export type PromiseCreateRes500 = Extract<PromiseCreateRes, { head: { status: 500 } }>;

export type PromiseSettleRes =
  | { kind: "promise.settle"; head: ResponseHead<200>; data: { promise: PromiseRecord } }
  | { kind: "promise.settle"; head: ResponseHead<400>; data: string }
  | { kind: "promise.settle"; head: ResponseHead<404>; data: string }
  | { kind: "promise.settle"; head: ResponseHead<429>; data: string }
  | { kind: "promise.settle"; head: ResponseHead<500>; data: string };
export type PromiseSettleRes200 = Extract<PromiseSettleRes, { head: { status: 200 } }>;
export type PromiseSettleRes400 = Extract<PromiseSettleRes, { head: { status: 400 } }>;
export type PromiseSettleRes404 = Extract<PromiseSettleRes, { head: { status: 404 } }>;
export type PromiseSettleRes429 = Extract<PromiseSettleRes, { head: { status: 429 } }>;
export type PromiseSettleRes500 = Extract<PromiseSettleRes, { head: { status: 500 } }>;

export type PromiseRegisterRes =
  | { kind: "promise.register"; head: ResponseHead<200>; data: { promise: PromiseRecord } }
  | { kind: "promise.register"; head: ResponseHead<400>; data: string }
  | { kind: "promise.register"; head: ResponseHead<404>; data: string }
  | { kind: "promise.register"; head: ResponseHead<422>; data: string }
  | { kind: "promise.register"; head: ResponseHead<429>; data: string }
  | { kind: "promise.register"; head: ResponseHead<500>; data: string };
export type PromiseRegisterRes200 = Extract<PromiseRegisterRes, { head: { status: 200 } }>;
export type PromiseRegisterRes400 = Extract<PromiseRegisterRes, { head: { status: 400 } }>;
export type PromiseRegisterRes404 = Extract<PromiseRegisterRes, { head: { status: 404 } }>;
export type PromiseRegisterRes422 = Extract<PromiseRegisterRes, { head: { status: 422 } }>;
export type PromiseRegisterRes429 = Extract<PromiseRegisterRes, { head: { status: 429 } }>;
export type PromiseRegisterRes500 = Extract<PromiseRegisterRes, { head: { status: 500 } }>;

export type PromiseSubscribeRes =
  | { kind: "promise.subscribe"; head: ResponseHead<200>; data: { promise: PromiseRecord } }
  | { kind: "promise.subscribe"; head: ResponseHead<400>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<404>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<429>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<500>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<501>; data: string };
export type PromiseSubscribeRes200 = Extract<PromiseSubscribeRes, { head: { status: 200 } }>;
export type PromiseSubscribeRes400 = Extract<PromiseSubscribeRes, { head: { status: 400 } }>;
export type PromiseSubscribeRes404 = Extract<PromiseSubscribeRes, { head: { status: 404 } }>;
export type PromiseSubscribeRes429 = Extract<PromiseSubscribeRes, { head: { status: 429 } }>;
export type PromiseSubscribeRes500 = Extract<PromiseSubscribeRes, { head: { status: 500 } }>;
export type PromiseSubscribeRes501 = Extract<PromiseSubscribeRes, { head: { status: 501 } }>;

// =============================================================================
// RESPONSES - TASK
// =============================================================================

export type TaskGetRes =
  | { kind: "task.get"; head: ResponseHead<200>; data: { task: TaskRecord } }
  | { kind: "task.get"; head: ResponseHead<400>; data: string }
  | { kind: "task.get"; head: ResponseHead<404>; data: string }
  | { kind: "task.get"; head: ResponseHead<429>; data: string }
  | { kind: "task.get"; head: ResponseHead<500>; data: string };
export type TaskGetRes200 = Extract<TaskGetRes, { head: { status: 200 } }>;
export type TaskGetRes400 = Extract<TaskGetRes, { head: { status: 400 } }>;
export type TaskGetRes404 = Extract<TaskGetRes, { head: { status: 404 } }>;
export type TaskGetRes429 = Extract<TaskGetRes, { head: { status: 429 } }>;
export type TaskGetRes500 = Extract<TaskGetRes, { head: { status: 500 } }>;

export type TaskCreateRes =
  | { kind: "task.create"; head: ResponseHead<200>; data: { task: TaskRecord; promise: PromiseRecord } }
  | { kind: "task.create"; head: ResponseHead<400>; data: string }
  | { kind: "task.create"; head: ResponseHead<409>; data: string }
  | { kind: "task.create"; head: ResponseHead<429>; data: string }
  | { kind: "task.create"; head: ResponseHead<500>; data: string }
  | { kind: "task.create"; head: ResponseHead<501>; data: string };
export type TaskCreateRes200 = Extract<TaskCreateRes, { head: { status: 200 } }>;
export type TaskCreateRes400 = Extract<TaskCreateRes, { head: { status: 400 } }>;
export type TaskCreateRes409 = Extract<TaskCreateRes, { head: { status: 409 } }>;
export type TaskCreateRes429 = Extract<TaskCreateRes, { head: { status: 429 } }>;
export type TaskCreateRes500 = Extract<TaskCreateRes, { head: { status: 500 } }>;
export type TaskCreateRes501 = Extract<TaskCreateRes, { head: { status: 501 } }>;

export type TaskAcquireRes =
  | { kind: "task.acquire"; head: ResponseHead<200>; data: { promise: PromiseRecord; preload: PromiseRecord[] } }
  | { kind: "task.acquire"; head: ResponseHead<400>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<404>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<409>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<429>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<500>; data: string };
export type TaskAcquireRes200 = Extract<TaskAcquireRes, { head: { status: 200 } }>;
export type TaskAcquireRes400 = Extract<TaskAcquireRes, { head: { status: 400 } }>;
export type TaskAcquireRes404 = Extract<TaskAcquireRes, { head: { status: 404 } }>;
export type TaskAcquireRes409 = Extract<TaskAcquireRes, { head: { status: 409 } }>;
export type TaskAcquireRes429 = Extract<TaskAcquireRes, { head: { status: 429 } }>;
export type TaskAcquireRes500 = Extract<TaskAcquireRes, { head: { status: 500 } }>;

export type TaskSuspendRes =
  | { kind: "task.suspend"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "task.suspend"; head: ResponseHead<300>; data: Record<string, never> }
  | { kind: "task.suspend"; head: ResponseHead<400>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<404>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<409>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<422>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<429>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<500>; data: string };
export type TaskSuspendRes200 = Extract<TaskSuspendRes, { head: { status: 200 } }>;
export type TaskSuspendRes300 = Extract<TaskSuspendRes, { head: { status: 300 } }>;
export type TaskSuspendRes400 = Extract<TaskSuspendRes, { head: { status: 400 } }>;
export type TaskSuspendRes404 = Extract<TaskSuspendRes, { head: { status: 404 } }>;
export type TaskSuspendRes409 = Extract<TaskSuspendRes, { head: { status: 409 } }>;
export type TaskSuspendRes422 = Extract<TaskSuspendRes, { head: { status: 422 } }>;
export type TaskSuspendRes429 = Extract<TaskSuspendRes, { head: { status: 429 } }>;
export type TaskSuspendRes500 = Extract<TaskSuspendRes, { head: { status: 500 } }>;

export type TaskFulfillRes =
  | { kind: "task.fulfill"; head: ResponseHead<200>; data: { promise: PromiseRecord } }
  | { kind: "task.fulfill"; head: ResponseHead<400>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<404>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<409>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<429>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<500>; data: string };
export type TaskFulfillRes200 = Extract<TaskFulfillRes, { head: { status: 200 } }>;
export type TaskFulfillRes400 = Extract<TaskFulfillRes, { head: { status: 400 } }>;
export type TaskFulfillRes404 = Extract<TaskFulfillRes, { head: { status: 404 } }>;
export type TaskFulfillRes409 = Extract<TaskFulfillRes, { head: { status: 409 } }>;
export type TaskFulfillRes429 = Extract<TaskFulfillRes, { head: { status: 429 } }>;
export type TaskFulfillRes500 = Extract<TaskFulfillRes, { head: { status: 500 } }>;

export type TaskReleaseRes =
  | { kind: "task.release"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "task.release"; head: ResponseHead<400>; data: string }
  | { kind: "task.release"; head: ResponseHead<404>; data: string }
  | { kind: "task.release"; head: ResponseHead<409>; data: string }
  | { kind: "task.release"; head: ResponseHead<429>; data: string }
  | { kind: "task.release"; head: ResponseHead<500>; data: string };
export type TaskReleaseRes200 = Extract<TaskReleaseRes, { head: { status: 200 } }>;
export type TaskReleaseRes400 = Extract<TaskReleaseRes, { head: { status: 400 } }>;
export type TaskReleaseRes404 = Extract<TaskReleaseRes, { head: { status: 404 } }>;
export type TaskReleaseRes409 = Extract<TaskReleaseRes, { head: { status: 409 } }>;
export type TaskReleaseRes429 = Extract<TaskReleaseRes, { head: { status: 429 } }>;
export type TaskReleaseRes500 = Extract<TaskReleaseRes, { head: { status: 500 } }>;

export type TaskFenceRes =
  | { kind: "task.fence"; head: ResponseHead<200>; data: { action: PromiseCreateRes | PromiseSettleRes } }
  | { kind: "task.fence"; head: ResponseHead<400>; data: string }
  | { kind: "task.fence"; head: ResponseHead<404>; data: string }
  | { kind: "task.fence"; head: ResponseHead<409>; data: string }
  | { kind: "task.fence"; head: ResponseHead<429>; data: string }
  | { kind: "task.fence"; head: ResponseHead<500>; data: string };
export type TaskFenceRes200 = Extract<TaskFenceRes, { head: { status: 200 } }>;
export type TaskFenceRes400 = Extract<TaskFenceRes, { head: { status: 400 } }>;
export type TaskFenceRes404 = Extract<TaskFenceRes, { head: { status: 404 } }>;
export type TaskFenceRes409 = Extract<TaskFenceRes, { head: { status: 409 } }>;
export type TaskFenceRes429 = Extract<TaskFenceRes, { head: { status: 429 } }>;
export type TaskFenceRes500 = Extract<TaskFenceRes, { head: { status: 500 } }>;

export type TaskHeartbeatRes =
  | { kind: "task.heartbeat"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "task.heartbeat"; head: ResponseHead<400>; data: string }
  | { kind: "task.heartbeat"; head: ResponseHead<429>; data: string }
  | { kind: "task.heartbeat"; head: ResponseHead<500>; data: string };
export type TaskHeartbeatRes200 = Extract<TaskHeartbeatRes, { head: { status: 200 } }>;
export type TaskHeartbeatRes400 = Extract<TaskHeartbeatRes, { head: { status: 400 } }>;
export type TaskHeartbeatRes429 = Extract<TaskHeartbeatRes, { head: { status: 429 } }>;
export type TaskHeartbeatRes500 = Extract<TaskHeartbeatRes, { head: { status: 500 } }>;

// =============================================================================
// RESPONSES - SCHEDULE
// =============================================================================

export type ScheduleGetRes =
  | { kind: "schedule.get"; head: ResponseHead<200>; data: { schedule: ScheduleRecord } }
  | { kind: "schedule.get"; head: ResponseHead<400>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<404>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<429>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<500>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<501>; data: string };
export type ScheduleGetRes200 = Extract<ScheduleGetRes, { head: { status: 200 } }>;
export type ScheduleGetRes400 = Extract<ScheduleGetRes, { head: { status: 400 } }>;
export type ScheduleGetRes404 = Extract<ScheduleGetRes, { head: { status: 404 } }>;
export type ScheduleGetRes429 = Extract<ScheduleGetRes, { head: { status: 429 } }>;
export type ScheduleGetRes500 = Extract<ScheduleGetRes, { head: { status: 500 } }>;
export type ScheduleGetRes501 = Extract<ScheduleGetRes, { head: { status: 501 } }>;

export type ScheduleCreateRes =
  | { kind: "schedule.create"; head: ResponseHead<200>; data: { schedule: ScheduleRecord } }
  | { kind: "schedule.create"; head: ResponseHead<400>; data: string }
  | { kind: "schedule.create"; head: ResponseHead<429>; data: string }
  | { kind: "schedule.create"; head: ResponseHead<500>; data: string }
  | { kind: "schedule.create"; head: ResponseHead<501>; data: string };
export type ScheduleCreateRes200 = Extract<ScheduleCreateRes, { head: { status: 200 } }>;
export type ScheduleCreateRes400 = Extract<ScheduleCreateRes, { head: { status: 400 } }>;
export type ScheduleCreateRes429 = Extract<ScheduleCreateRes, { head: { status: 429 } }>;
export type ScheduleCreateRes500 = Extract<ScheduleCreateRes, { head: { status: 500 } }>;
export type ScheduleCreateRes501 = Extract<ScheduleCreateRes, { head: { status: 501 } }>;

export type ScheduleDeleteRes =
  | { kind: "schedule.delete"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "schedule.delete"; head: ResponseHead<400>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<404>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<429>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<500>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<501>; data: string };
export type ScheduleDeleteRes200 = Extract<ScheduleDeleteRes, { head: { status: 200 } }>;
export type ScheduleDeleteRes400 = Extract<ScheduleDeleteRes, { head: { status: 400 } }>;
export type ScheduleDeleteRes404 = Extract<ScheduleDeleteRes, { head: { status: 404 } }>;
export type ScheduleDeleteRes429 = Extract<ScheduleDeleteRes, { head: { status: 429 } }>;
export type ScheduleDeleteRes500 = Extract<ScheduleDeleteRes, { head: { status: 500 } }>;
export type ScheduleDeleteRes501 = Extract<ScheduleDeleteRes, { head: { status: 501 } }>;

// =============================================================================
// RESPONSES - DEBUG
// =============================================================================

export type DebugStartRes =
  | { kind: "debug.start"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "debug.start"; head: ResponseHead<400>; data: string }
  | { kind: "debug.start"; head: ResponseHead<429>; data: string }
  | { kind: "debug.start"; head: ResponseHead<500>; data: string }
  | { kind: "debug.start"; head: ResponseHead<501>; data: string };
export type DebugStartRes200 = Extract<DebugStartRes, { head: { status: 200 } }>;
export type DebugStartRes400 = Extract<DebugStartRes, { head: { status: 400 } }>;
export type DebugStartRes429 = Extract<DebugStartRes, { head: { status: 429 } }>;
export type DebugStartRes500 = Extract<DebugStartRes, { head: { status: 500 } }>;
export type DebugStartRes501 = Extract<DebugStartRes, { head: { status: 501 } }>;

export type DebugResetRes =
  | { kind: "debug.reset"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "debug.reset"; head: ResponseHead<400>; data: string }
  | { kind: "debug.reset"; head: ResponseHead<429>; data: string }
  | { kind: "debug.reset"; head: ResponseHead<500>; data: string }
  | { kind: "debug.reset"; head: ResponseHead<501>; data: string };
export type DebugResetRes200 = Extract<DebugResetRes, { head: { status: 200 } }>;
export type DebugResetRes400 = Extract<DebugResetRes, { head: { status: 400 } }>;
export type DebugResetRes429 = Extract<DebugResetRes, { head: { status: 429 } }>;
export type DebugResetRes500 = Extract<DebugResetRes, { head: { status: 500 } }>;
export type DebugResetRes501 = Extract<DebugResetRes, { head: { status: 501 } }>;

export type DebugTickAction =
  | { kind: "promise.settle"; data: { id: string; state: "rejected_timedout" | "resolved" } }
  | { kind: "task.release"; data: { id: string; version: number } }
  | { kind: "task.retry"; data: { id: string; version: number } };

export type DebugTickRes =
  | { kind: "debug.tick"; head: ResponseHead<200>; data: DebugTickAction[] }
  | { kind: "debug.tick"; head: ResponseHead<400>; data: string }
  | { kind: "debug.tick"; head: ResponseHead<429>; data: string }
  | { kind: "debug.tick"; head: ResponseHead<500>; data: string }
  | { kind: "debug.tick"; head: ResponseHead<501>; data: string };
export type DebugTickRes200 = Extract<DebugTickRes, { head: { status: 200 } }>;
export type DebugTickRes400 = Extract<DebugTickRes, { head: { status: 400 } }>;
export type DebugTickRes429 = Extract<DebugTickRes, { head: { status: 429 } }>;
export type DebugTickRes500 = Extract<DebugTickRes, { head: { status: 500 } }>;
export type DebugTickRes501 = Extract<DebugTickRes, { head: { status: 501 } }>;

export type DebugSnapRes =
  | {
      kind: "debug.snap";
      head: ResponseHead<200>;
      data: {
        promises: PromiseRecord[];
        promiseTimeouts: { id: string; timeout: number }[];
        callbacks: { awaiter: string; awaited: string }[];
        tasks: TaskRecord[];
        taskTimeouts: { id: string; type: number; timeout: number }[];
        messages: { id: string; version: number; address: string }[];
      };
    }
  | { kind: "debug.snap"; head: ResponseHead<400>; data: string }
  | { kind: "debug.snap"; head: ResponseHead<429>; data: string }
  | { kind: "debug.snap"; head: ResponseHead<500>; data: string }
  | { kind: "debug.snap"; head: ResponseHead<501>; data: string };
export type DebugSnapRes200 = Extract<DebugSnapRes, { head: { status: 200 } }>;
export type DebugSnapRes400 = Extract<DebugSnapRes, { head: { status: 400 } }>;
export type DebugSnapRes429 = Extract<DebugSnapRes, { head: { status: 429 } }>;
export type DebugSnapRes500 = Extract<DebugSnapRes, { head: { status: 500 } }>;
export type DebugSnapRes501 = Extract<DebugSnapRes, { head: { status: 501 } }>;

export type DebugStopRes =
  | { kind: "debug.stop"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "debug.stop"; head: ResponseHead<400>; data: string }
  | { kind: "debug.stop"; head: ResponseHead<429>; data: string }
  | { kind: "debug.stop"; head: ResponseHead<500>; data: string }
  | { kind: "debug.stop"; head: ResponseHead<501>; data: string };
export type DebugStopRes200 = Extract<DebugStopRes, { head: { status: 200 } }>;
export type DebugStopRes400 = Extract<DebugStopRes, { head: { status: 400 } }>;
export type DebugStopRes429 = Extract<DebugStopRes, { head: { status: 429 } }>;
export type DebugStopRes500 = Extract<DebugStopRes, { head: { status: 500 } }>;
export type DebugStopRes501 = Extract<DebugStopRes, { head: { status: 501 } }>;

// =============================================================================
// RESPONSE UNION
// =============================================================================

export type Response =
  | PromiseGetRes
  | PromiseCreateRes
  | PromiseSettleRes
  | PromiseRegisterRes
  | PromiseSubscribeRes
  | TaskGetRes
  | TaskCreateRes
  | TaskAcquireRes
  | TaskSuspendRes
  | TaskFulfillRes
  | TaskReleaseRes
  | TaskFenceRes
  | TaskHeartbeatRes
  | ScheduleGetRes
  | ScheduleCreateRes
  | ScheduleDeleteRes
  | DebugStartRes
  | DebugResetRes
  | DebugTickRes
  | DebugSnapRes
  | DebugStopRes;

// =============================================================================
// MESSAGES
// =============================================================================

export type MessageHead = { serverUrl?: string };

export type ExecuteMsg = {
  kind: "execute";
  head: MessageHead;
  data: { task: { id: string; version: number } };
};

export type NotifyMsg = {
  kind: "notify";
  head: MessageHead;
  data: { promise: PromiseRecord };
};

export type Message = ExecuteMsg | NotifyMsg;

// =============================================================================
// TYPE GUARDS
// =============================================================================

// Promise Get
export function isPromiseGetRes200(res: PromiseGetRes): res is PromiseGetRes200 {
  return res.head.status === 200;
}
export function isPromiseGetRes400(res: PromiseGetRes): res is PromiseGetRes400 {
  return res.head.status === 400;
}
export function isPromiseGetRes404(res: PromiseGetRes): res is PromiseGetRes404 {
  return res.head.status === 404;
}
export function isPromiseGetRes429(res: PromiseGetRes): res is PromiseGetRes429 {
  return res.head.status === 429;
}
export function isPromiseGetRes500(res: PromiseGetRes): res is PromiseGetRes500 {
  return res.head.status === 500;
}

// Promise Create
export function isPromiseCreateRes200(res: PromiseCreateRes): res is PromiseCreateRes200 {
  return res.head.status === 200;
}
export function isPromiseCreateRes400(res: PromiseCreateRes): res is PromiseCreateRes400 {
  return res.head.status === 400;
}
export function isPromiseCreateRes429(res: PromiseCreateRes): res is PromiseCreateRes429 {
  return res.head.status === 429;
}
export function isPromiseCreateRes500(res: PromiseCreateRes): res is PromiseCreateRes500 {
  return res.head.status === 500;
}

// Promise Settle
export function isPromiseSettleRes200(res: PromiseSettleRes): res is PromiseSettleRes200 {
  return res.head.status === 200;
}
export function isPromiseSettleRes400(res: PromiseSettleRes): res is PromiseSettleRes400 {
  return res.head.status === 400;
}
export function isPromiseSettleRes404(res: PromiseSettleRes): res is PromiseSettleRes404 {
  return res.head.status === 404;
}
export function isPromiseSettleRes429(res: PromiseSettleRes): res is PromiseSettleRes429 {
  return res.head.status === 429;
}
export function isPromiseSettleRes500(res: PromiseSettleRes): res is PromiseSettleRes500 {
  return res.head.status === 500;
}

// Promise Register
export function isPromiseRegisterRes200(res: PromiseRegisterRes): res is PromiseRegisterRes200 {
  return res.head.status === 200;
}
export function isPromiseRegisterRes400(res: PromiseRegisterRes): res is PromiseRegisterRes400 {
  return res.head.status === 400;
}
export function isPromiseRegisterRes404(res: PromiseRegisterRes): res is PromiseRegisterRes404 {
  return res.head.status === 404;
}
export function isPromiseRegisterRes422(res: PromiseRegisterRes): res is PromiseRegisterRes422 {
  return res.head.status === 422;
}
export function isPromiseRegisterRes429(res: PromiseRegisterRes): res is PromiseRegisterRes429 {
  return res.head.status === 429;
}
export function isPromiseRegisterRes500(res: PromiseRegisterRes): res is PromiseRegisterRes500 {
  return res.head.status === 500;
}

// Promise Subscribe
export function isPromiseSubscribeRes200(res: PromiseSubscribeRes): res is PromiseSubscribeRes200 {
  return res.head.status === 200;
}
export function isPromiseSubscribeRes400(res: PromiseSubscribeRes): res is PromiseSubscribeRes400 {
  return res.head.status === 400;
}
export function isPromiseSubscribeRes404(res: PromiseSubscribeRes): res is PromiseSubscribeRes404 {
  return res.head.status === 404;
}
export function isPromiseSubscribeRes429(res: PromiseSubscribeRes): res is PromiseSubscribeRes429 {
  return res.head.status === 429;
}
export function isPromiseSubscribeRes500(res: PromiseSubscribeRes): res is PromiseSubscribeRes500 {
  return res.head.status === 500;
}
export function isPromiseSubscribeRes501(res: PromiseSubscribeRes): res is PromiseSubscribeRes501 {
  return res.head.status === 501;
}

// Task Get
export function isTaskGetRes200(res: TaskGetRes): res is TaskGetRes200 {
  return res.head.status === 200;
}
export function isTaskGetRes400(res: TaskGetRes): res is TaskGetRes400 {
  return res.head.status === 400;
}
export function isTaskGetRes404(res: TaskGetRes): res is TaskGetRes404 {
  return res.head.status === 404;
}
export function isTaskGetRes429(res: TaskGetRes): res is TaskGetRes429 {
  return res.head.status === 429;
}
export function isTaskGetRes500(res: TaskGetRes): res is TaskGetRes500 {
  return res.head.status === 500;
}

// Task Create
export function isTaskCreateRes200(res: TaskCreateRes): res is TaskCreateRes200 {
  return res.head.status === 200;
}
export function isTaskCreateRes400(res: TaskCreateRes): res is TaskCreateRes400 {
  return res.head.status === 400;
}
export function isTaskCreateRes409(res: TaskCreateRes): res is TaskCreateRes409 {
  return res.head.status === 409;
}
export function isTaskCreateRes429(res: TaskCreateRes): res is TaskCreateRes429 {
  return res.head.status === 429;
}
export function isTaskCreateRes500(res: TaskCreateRes): res is TaskCreateRes500 {
  return res.head.status === 500;
}
export function isTaskCreateRes501(res: TaskCreateRes): res is TaskCreateRes501 {
  return res.head.status === 501;
}

// Task Acquire
export function isTaskAcquireRes200(res: TaskAcquireRes): res is TaskAcquireRes200 {
  return res.head.status === 200;
}
export function isTaskAcquireRes400(res: TaskAcquireRes): res is TaskAcquireRes400 {
  return res.head.status === 400;
}
export function isTaskAcquireRes404(res: TaskAcquireRes): res is TaskAcquireRes404 {
  return res.head.status === 404;
}
export function isTaskAcquireRes409(res: TaskAcquireRes): res is TaskAcquireRes409 {
  return res.head.status === 409;
}
export function isTaskAcquireRes429(res: TaskAcquireRes): res is TaskAcquireRes429 {
  return res.head.status === 429;
}
export function isTaskAcquireRes500(res: TaskAcquireRes): res is TaskAcquireRes500 {
  return res.head.status === 500;
}

// Task Suspend
export function isTaskSuspendRes200(res: TaskSuspendRes): res is TaskSuspendRes200 {
  return res.head.status === 200;
}
export function isTaskSuspendRes300(res: TaskSuspendRes): res is TaskSuspendRes300 {
  return res.head.status === 300;
}
export function isTaskSuspendRes400(res: TaskSuspendRes): res is TaskSuspendRes400 {
  return res.head.status === 400;
}
export function isTaskSuspendRes404(res: TaskSuspendRes): res is TaskSuspendRes404 {
  return res.head.status === 404;
}
export function isTaskSuspendRes409(res: TaskSuspendRes): res is TaskSuspendRes409 {
  return res.head.status === 409;
}
export function isTaskSuspendRes422(res: TaskSuspendRes): res is TaskSuspendRes422 {
  return res.head.status === 422;
}
export function isTaskSuspendRes429(res: TaskSuspendRes): res is TaskSuspendRes429 {
  return res.head.status === 429;
}
export function isTaskSuspendRes500(res: TaskSuspendRes): res is TaskSuspendRes500 {
  return res.head.status === 500;
}

// Task Fulfill
export function isTaskFulfillRes200(res: TaskFulfillRes): res is TaskFulfillRes200 {
  return res.head.status === 200;
}
export function isTaskFulfillRes400(res: TaskFulfillRes): res is TaskFulfillRes400 {
  return res.head.status === 400;
}
export function isTaskFulfillRes404(res: TaskFulfillRes): res is TaskFulfillRes404 {
  return res.head.status === 404;
}
export function isTaskFulfillRes409(res: TaskFulfillRes): res is TaskFulfillRes409 {
  return res.head.status === 409;
}
export function isTaskFulfillRes429(res: TaskFulfillRes): res is TaskFulfillRes429 {
  return res.head.status === 429;
}
export function isTaskFulfillRes500(res: TaskFulfillRes): res is TaskFulfillRes500 {
  return res.head.status === 500;
}

// Task Release
export function isTaskReleaseRes200(res: TaskReleaseRes): res is TaskReleaseRes200 {
  return res.head.status === 200;
}
export function isTaskReleaseRes400(res: TaskReleaseRes): res is TaskReleaseRes400 {
  return res.head.status === 400;
}
export function isTaskReleaseRes404(res: TaskReleaseRes): res is TaskReleaseRes404 {
  return res.head.status === 404;
}
export function isTaskReleaseRes409(res: TaskReleaseRes): res is TaskReleaseRes409 {
  return res.head.status === 409;
}
export function isTaskReleaseRes429(res: TaskReleaseRes): res is TaskReleaseRes429 {
  return res.head.status === 429;
}
export function isTaskReleaseRes500(res: TaskReleaseRes): res is TaskReleaseRes500 {
  return res.head.status === 500;
}

// Task Fence
export function isTaskFenceRes200(res: TaskFenceRes): res is TaskFenceRes200 {
  return res.head.status === 200;
}
export function isTaskFenceRes400(res: TaskFenceRes): res is TaskFenceRes400 {
  return res.head.status === 400;
}
export function isTaskFenceRes404(res: TaskFenceRes): res is TaskFenceRes404 {
  return res.head.status === 404;
}
export function isTaskFenceRes409(res: TaskFenceRes): res is TaskFenceRes409 {
  return res.head.status === 409;
}
export function isTaskFenceRes429(res: TaskFenceRes): res is TaskFenceRes429 {
  return res.head.status === 429;
}
export function isTaskFenceRes500(res: TaskFenceRes): res is TaskFenceRes500 {
  return res.head.status === 500;
}

// Task Heartbeat
export function isTaskHeartbeatRes200(res: TaskHeartbeatRes): res is TaskHeartbeatRes200 {
  return res.head.status === 200;
}
export function isTaskHeartbeatRes400(res: TaskHeartbeatRes): res is TaskHeartbeatRes400 {
  return res.head.status === 400;
}
export function isTaskHeartbeatRes429(res: TaskHeartbeatRes): res is TaskHeartbeatRes429 {
  return res.head.status === 429;
}
export function isTaskHeartbeatRes500(res: TaskHeartbeatRes): res is TaskHeartbeatRes500 {
  return res.head.status === 500;
}

// Schedule Get
export function isScheduleGetRes200(res: ScheduleGetRes): res is ScheduleGetRes200 {
  return res.head.status === 200;
}
export function isScheduleGetRes400(res: ScheduleGetRes): res is ScheduleGetRes400 {
  return res.head.status === 400;
}
export function isScheduleGetRes404(res: ScheduleGetRes): res is ScheduleGetRes404 {
  return res.head.status === 404;
}
export function isScheduleGetRes429(res: ScheduleGetRes): res is ScheduleGetRes429 {
  return res.head.status === 429;
}
export function isScheduleGetRes500(res: ScheduleGetRes): res is ScheduleGetRes500 {
  return res.head.status === 500;
}
export function isScheduleGetRes501(res: ScheduleGetRes): res is ScheduleGetRes501 {
  return res.head.status === 501;
}

// Schedule Create
export function isScheduleCreateRes200(res: ScheduleCreateRes): res is ScheduleCreateRes200 {
  return res.head.status === 200;
}
export function isScheduleCreateRes400(res: ScheduleCreateRes): res is ScheduleCreateRes400 {
  return res.head.status === 400;
}
export function isScheduleCreateRes429(res: ScheduleCreateRes): res is ScheduleCreateRes429 {
  return res.head.status === 429;
}
export function isScheduleCreateRes500(res: ScheduleCreateRes): res is ScheduleCreateRes500 {
  return res.head.status === 500;
}
export function isScheduleCreateRes501(res: ScheduleCreateRes): res is ScheduleCreateRes501 {
  return res.head.status === 501;
}

// Schedule Delete
export function isScheduleDeleteRes200(res: ScheduleDeleteRes): res is ScheduleDeleteRes200 {
  return res.head.status === 200;
}
export function isScheduleDeleteRes400(res: ScheduleDeleteRes): res is ScheduleDeleteRes400 {
  return res.head.status === 400;
}
export function isScheduleDeleteRes404(res: ScheduleDeleteRes): res is ScheduleDeleteRes404 {
  return res.head.status === 404;
}
export function isScheduleDeleteRes429(res: ScheduleDeleteRes): res is ScheduleDeleteRes429 {
  return res.head.status === 429;
}
export function isScheduleDeleteRes500(res: ScheduleDeleteRes): res is ScheduleDeleteRes500 {
  return res.head.status === 500;
}
export function isScheduleDeleteRes501(res: ScheduleDeleteRes): res is ScheduleDeleteRes501 {
  return res.head.status === 501;
}

// Debug Start
export function isDebugStartRes200(res: DebugStartRes): res is DebugStartRes200 {
  return res.head.status === 200;
}
export function isDebugStartRes400(res: DebugStartRes): res is DebugStartRes400 {
  return res.head.status === 400;
}
export function isDebugStartRes429(res: DebugStartRes): res is DebugStartRes429 {
  return res.head.status === 429;
}
export function isDebugStartRes500(res: DebugStartRes): res is DebugStartRes500 {
  return res.head.status === 500;
}
export function isDebugStartRes501(res: DebugStartRes): res is DebugStartRes501 {
  return res.head.status === 501;
}

// Debug Reset
export function isDebugResetRes200(res: DebugResetRes): res is DebugResetRes200 {
  return res.head.status === 200;
}
export function isDebugResetRes400(res: DebugResetRes): res is DebugResetRes400 {
  return res.head.status === 400;
}
export function isDebugResetRes429(res: DebugResetRes): res is DebugResetRes429 {
  return res.head.status === 429;
}
export function isDebugResetRes500(res: DebugResetRes): res is DebugResetRes500 {
  return res.head.status === 500;
}
export function isDebugResetRes501(res: DebugResetRes): res is DebugResetRes501 {
  return res.head.status === 501;
}

// Debug Tick
export function isDebugTickRes200(res: DebugTickRes): res is DebugTickRes200 {
  return res.head.status === 200;
}
export function isDebugTickRes400(res: DebugTickRes): res is DebugTickRes400 {
  return res.head.status === 400;
}
export function isDebugTickRes429(res: DebugTickRes): res is DebugTickRes429 {
  return res.head.status === 429;
}
export function isDebugTickRes500(res: DebugTickRes): res is DebugTickRes500 {
  return res.head.status === 500;
}
export function isDebugTickRes501(res: DebugTickRes): res is DebugTickRes501 {
  return res.head.status === 501;
}

// Debug Snap
export function isDebugSnapRes200(res: DebugSnapRes): res is DebugSnapRes200 {
  return res.head.status === 200;
}
export function isDebugSnapRes400(res: DebugSnapRes): res is DebugSnapRes400 {
  return res.head.status === 400;
}
export function isDebugSnapRes429(res: DebugSnapRes): res is DebugSnapRes429 {
  return res.head.status === 429;
}
export function isDebugSnapRes500(res: DebugSnapRes): res is DebugSnapRes500 {
  return res.head.status === 500;
}
export function isDebugSnapRes501(res: DebugSnapRes): res is DebugSnapRes501 {
  return res.head.status === 501;
}

// Debug Stop
export function isDebugStopRes200(res: DebugStopRes): res is DebugStopRes200 {
  return res.head.status === 200;
}
export function isDebugStopRes400(res: DebugStopRes): res is DebugStopRes400 {
  return res.head.status === 400;
}
export function isDebugStopRes429(res: DebugStopRes): res is DebugStopRes429 {
  return res.head.status === 429;
}
export function isDebugStopRes500(res: DebugStopRes): res is DebugStopRes500 {
  return res.head.status === 500;
}
export function isDebugStopRes501(res: DebugStopRes): res is DebugStopRes501 {
  return res.head.status === 501;
}
