// =============================================================================
// SHARED TYPES
// =============================================================================

export type Value = {
  headers?: Record<string, string>;
  data?: any; // TODO: express external string type vs internal any type
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
  | {
      kind: "promise.get";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "promise.get"; head: ResponseHead<400>; data: string }
  | { kind: "promise.get"; head: ResponseHead<404>; data: string }
  | { kind: "promise.get"; head: ResponseHead<429>; data: string }
  | { kind: "promise.get"; head: ResponseHead<500>; data: string };

export type PromiseCreateRes =
  | {
      kind: "promise.create";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "promise.create"; head: ResponseHead<400>; data: string }
  | { kind: "promise.create"; head: ResponseHead<429>; data: string }
  | { kind: "promise.create"; head: ResponseHead<500>; data: string };

export type PromiseSettleRes =
  | {
      kind: "promise.settle";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "promise.settle"; head: ResponseHead<400>; data: string }
  | { kind: "promise.settle"; head: ResponseHead<404>; data: string }
  | { kind: "promise.settle"; head: ResponseHead<429>; data: string }
  | { kind: "promise.settle"; head: ResponseHead<500>; data: string };

export type PromiseRegisterRes =
  | {
      kind: "promise.register";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "promise.register"; head: ResponseHead<400>; data: string }
  | { kind: "promise.register"; head: ResponseHead<404>; data: string }
  | { kind: "promise.register"; head: ResponseHead<422>; data: string }
  | { kind: "promise.register"; head: ResponseHead<429>; data: string }
  | { kind: "promise.register"; head: ResponseHead<500>; data: string };

export type PromiseSubscribeRes =
  | {
      kind: "promise.subscribe";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "promise.subscribe"; head: ResponseHead<400>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<404>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<429>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<500>; data: string }
  | { kind: "promise.subscribe"; head: ResponseHead<501>; data: string };

// =============================================================================
// RESPONSES - TASK
// =============================================================================

export type TaskGetRes =
  | { kind: "task.get"; head: ResponseHead<200>; data: { task: TaskRecord } }
  | { kind: "task.get"; head: ResponseHead<400>; data: string }
  | { kind: "task.get"; head: ResponseHead<404>; data: string }
  | { kind: "task.get"; head: ResponseHead<429>; data: string }
  | { kind: "task.get"; head: ResponseHead<500>; data: string };

export type TaskCreateRes =
  | {
      kind: "task.create";
      head: ResponseHead<200>;
      data: { task: TaskRecord; promise: PromiseRecord };
    }
  | { kind: "task.create"; head: ResponseHead<400>; data: string }
  | { kind: "task.create"; head: ResponseHead<409>; data: string }
  | { kind: "task.create"; head: ResponseHead<429>; data: string }
  | { kind: "task.create"; head: ResponseHead<500>; data: string }
  | { kind: "task.create"; head: ResponseHead<501>; data: string };

export type TaskAcquireRes =
  | {
      kind: "task.acquire";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord; preload: PromiseRecord[] };
    }
  | { kind: "task.acquire"; head: ResponseHead<400>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<404>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<409>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<429>; data: string }
  | { kind: "task.acquire"; head: ResponseHead<500>; data: string };

export type TaskSuspendRes =
  | {
      kind: "task.suspend";
      head: ResponseHead<200>;
      data: Record<string, never>;
    }
  | {
      kind: "task.suspend";
      head: ResponseHead<300>;
      data: Record<string, never>;
    }
  | { kind: "task.suspend"; head: ResponseHead<400>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<404>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<409>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<422>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<429>; data: string }
  | { kind: "task.suspend"; head: ResponseHead<500>; data: string };

export type TaskFulfillRes =
  | {
      kind: "task.fulfill";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "task.fulfill"; head: ResponseHead<400>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<404>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<409>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<429>; data: string }
  | { kind: "task.fulfill"; head: ResponseHead<500>; data: string };

export type TaskReleaseRes =
  | {
      kind: "task.release";
      head: ResponseHead<200>;
      data: Record<string, never>;
    }
  | { kind: "task.release"; head: ResponseHead<400>; data: string }
  | { kind: "task.release"; head: ResponseHead<404>; data: string }
  | { kind: "task.release"; head: ResponseHead<409>; data: string }
  | { kind: "task.release"; head: ResponseHead<429>; data: string }
  | { kind: "task.release"; head: ResponseHead<500>; data: string };

export type TaskFenceRes =
  | {
      kind: "task.fence";
      head: ResponseHead<200>;
      data: { action: PromiseCreateRes | PromiseSettleRes };
    }
  | { kind: "task.fence"; head: ResponseHead<400>; data: string }
  | { kind: "task.fence"; head: ResponseHead<404>; data: string }
  | { kind: "task.fence"; head: ResponseHead<409>; data: string }
  | { kind: "task.fence"; head: ResponseHead<429>; data: string }
  | { kind: "task.fence"; head: ResponseHead<500>; data: string };

export type TaskHeartbeatRes =
  | {
      kind: "task.heartbeat";
      head: ResponseHead<200>;
      data: Record<string, never>;
    }
  | { kind: "task.heartbeat"; head: ResponseHead<400>; data: string }
  | { kind: "task.heartbeat"; head: ResponseHead<429>; data: string }
  | { kind: "task.heartbeat"; head: ResponseHead<500>; data: string };

// =============================================================================
// RESPONSES - SCHEDULE
// =============================================================================

export type ScheduleGetRes =
  | {
      kind: "schedule.get";
      head: ResponseHead<200>;
      data: { schedule: ScheduleRecord };
    }
  | { kind: "schedule.get"; head: ResponseHead<400>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<404>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<429>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<500>; data: string }
  | { kind: "schedule.get"; head: ResponseHead<501>; data: string };

export type ScheduleCreateRes =
  | {
      kind: "schedule.create";
      head: ResponseHead<200>;
      data: { schedule: ScheduleRecord };
    }
  | { kind: "schedule.create"; head: ResponseHead<400>; data: string }
  | { kind: "schedule.create"; head: ResponseHead<429>; data: string }
  | { kind: "schedule.create"; head: ResponseHead<500>; data: string }
  | { kind: "schedule.create"; head: ResponseHead<501>; data: string };

export type ScheduleDeleteRes =
  | {
      kind: "schedule.delete";
      head: ResponseHead<200>;
      data: Record<string, never>;
    }
  | { kind: "schedule.delete"; head: ResponseHead<400>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<404>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<429>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<500>; data: string }
  | { kind: "schedule.delete"; head: ResponseHead<501>; data: string };

// =============================================================================
// RESPONSES - DEBUG
// =============================================================================

export type DebugStartRes =
  | {
      kind: "debug.start";
      head: ResponseHead<200>;
      data: Record<string, never>;
    }
  | { kind: "debug.start"; head: ResponseHead<400>; data: string }
  | { kind: "debug.start"; head: ResponseHead<429>; data: string }
  | { kind: "debug.start"; head: ResponseHead<500>; data: string }
  | { kind: "debug.start"; head: ResponseHead<501>; data: string };

export type DebugResetRes =
  | {
      kind: "debug.reset";
      head: ResponseHead<200>;
      data: Record<string, never>;
    }
  | { kind: "debug.reset"; head: ResponseHead<400>; data: string }
  | { kind: "debug.reset"; head: ResponseHead<429>; data: string }
  | { kind: "debug.reset"; head: ResponseHead<500>; data: string }
  | { kind: "debug.reset"; head: ResponseHead<501>; data: string };

export type DebugTickAction =
  | {
      kind: "promise.settle";
      data: { id: string; state: "rejected_timedout" | "resolved" };
    }
  | { kind: "task.release"; data: { id: string; version: number } }
  | { kind: "task.retry"; data: { id: string; version: number } };

export type DebugTickRes =
  | { kind: "debug.tick"; head: ResponseHead<200>; data: DebugTickAction[] }
  | { kind: "debug.tick"; head: ResponseHead<400>; data: string }
  | { kind: "debug.tick"; head: ResponseHead<429>; data: string }
  | { kind: "debug.tick"; head: ResponseHead<500>; data: string }
  | { kind: "debug.tick"; head: ResponseHead<501>; data: string };

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

export type DebugStopRes =
  | { kind: "debug.stop"; head: ResponseHead<200>; data: Record<string, never> }
  | { kind: "debug.stop"; head: ResponseHead<400>; data: string }
  | { kind: "debug.stop"; head: ResponseHead<429>; data: string }
  | { kind: "debug.stop"; head: ResponseHead<500>; data: string }
  | { kind: "debug.stop"; head: ResponseHead<501>; data: string };

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

export function isSuccess<T extends Response>(res: T): res is Extract<T, { head: { status: 200 } }> {
  return res.head.status === 200;
}

export function isRedirect<T extends Response>(res: T): res is Extract<T, { head: { status: 300 } }> {
  return res.head.status === 300;
}

export function isBadRequest<T extends Response>(res: T): res is Extract<T, { head: { status: 400 } }> {
  return res.head.status === 400;
}

export function isNotFound<T extends Response>(res: T): res is Extract<T, { head: { status: 404 } }> {
  return res.head.status === 404;
}

export function isConflict<T extends Response>(res: T): res is Extract<T, { head: { status: 409 } }> {
  return res.head.status === 409;
}

export function isUnprocessable<T extends Response>(res: T): res is Extract<T, { head: { status: 422 } }> {
  return res.head.status === 422;
}

export function isRateLimited<T extends Response>(res: T): res is Extract<T, { head: { status: 429 } }> {
  return res.head.status === 429;
}

export function isError<T extends Response>(res: T): res is Extract<T, { head: { status: 500 } }> {
  return res.head.status === 500;
}

export function isNotImplemented<T extends Response>(res: T): res is Extract<T, { head: { status: 501 } }> {
  return res.head.status === 501;
}
