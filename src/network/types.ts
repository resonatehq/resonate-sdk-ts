// =============================================================================
// SHARED TYPES
// =============================================================================

export type Value = {
  headers?: Record<string, string>;
  data?: any;
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
// REQUEST HEAD
// =============================================================================

export type RequestHead = {
  auth?: string;
  corrId: string;
  version: string;
  "resonate:debug_time"?: number;
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

export type PromiseRegisterCallbackReq = {
  kind: "promise.register_callback";
  head: RequestHead;
  data: {
    awaited: string;
    awaiter: string;
  };
};

export type PromiseRegisterListenerReq = {
  kind: "promise.register_listener";
  head: RequestHead;
  data: {
    awaited: string;
    address: string;
  };
};

export type PromiseSearchReq = {
  kind: "promise.search";
  head: RequestHead;
  data: {
    state?: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
    tags?: Record<string, string>;
    limit?: number;
    cursor?: string;
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

export type TaskReleaseReq = {
  kind: "task.release";
  head: RequestHead;
  data: {
    id: string;
    version: number;
  };
};

export type TaskSuspendReq = {
  kind: "task.suspend";
  head: RequestHead;
  data: {
    id: string;
    version: number;
    actions: PromiseRegisterCallbackReq[];
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

export type TaskSearchReq = {
  kind: "task.search";
  head: RequestHead;
  data: {
    state?: "pending" | "acquired" | "suspended" | "fulfilled";
    limit?: number;
    cursor?: string;
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

export type ScheduleSearchReq = {
  kind: "schedule.search";
  head: RequestHead;
  data: {
    tags?: Record<string, string>;
    limit?: number;
    cursor?: string;
  };
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
  | PromiseRegisterCallbackReq
  | PromiseRegisterListenerReq
  | PromiseSearchReq
  | TaskGetReq
  | TaskCreateReq
  | TaskAcquireReq
  | TaskReleaseReq
  | TaskSuspendReq
  | TaskFulfillReq
  | TaskFenceReq
  | TaskHeartbeatReq
  | TaskSearchReq
  | ScheduleGetReq
  | ScheduleCreateReq
  | ScheduleDeleteReq
  | ScheduleSearchReq
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

export type PromiseRegisterCallbackRes =
  | {
      kind: "promise.register_callback";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "promise.register_callback"; head: ResponseHead<400>; data: string }
  | { kind: "promise.register_callback"; head: ResponseHead<404>; data: string }
  | { kind: "promise.register_callback"; head: ResponseHead<422>; data: string }
  | { kind: "promise.register_callback"; head: ResponseHead<429>; data: string }
  | { kind: "promise.register_callback"; head: ResponseHead<500>; data: string };

export type PromiseRegisterListenerRes =
  | {
      kind: "promise.register_listener";
      head: ResponseHead<200>;
      data: { promise: PromiseRecord };
    }
  | { kind: "promise.register_listener"; head: ResponseHead<400>; data: string }
  | { kind: "promise.register_listener"; head: ResponseHead<404>; data: string }
  | { kind: "promise.register_listener"; head: ResponseHead<429>; data: string }
  | { kind: "promise.register_listener"; head: ResponseHead<500>; data: string }
  | { kind: "promise.register_listener"; head: ResponseHead<501>; data: string };

export type PromiseSearchRes =
  | {
      kind: "promise.search";
      head: ResponseHead<200>;
      data: { promises: PromiseRecord[]; cursor?: string };
    }
  | { kind: "promise.search"; head: ResponseHead<400>; data: string }
  | { kind: "promise.search"; head: ResponseHead<429>; data: string }
  | { kind: "promise.search"; head: ResponseHead<500>; data: string }
  | { kind: "promise.search"; head: ResponseHead<501>; data: string };

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
      data: { task: TaskRecord; promise: PromiseRecord; preload: PromiseRecord[] };
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

export type TaskSuspendRes =
  | {
      kind: "task.suspend";
      head: ResponseHead<200>;
      data: Record<string, never>;
    }
  | {
      kind: "task.suspend";
      head: ResponseHead<300>;
      data: { preload: PromiseRecord[] };
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

export type TaskFenceRes =
  | {
      kind: "task.fence";
      head: ResponseHead<200>;
      data: { action: PromiseCreateRes | PromiseSettleRes; preload: PromiseRecord[] };
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

export type TaskSearchRes =
  | {
      kind: "task.search";
      head: ResponseHead<200>;
      data: { tasks: TaskRecord[]; cursor?: string };
    }
  | { kind: "task.search"; head: ResponseHead<400>; data: string }
  | { kind: "task.search"; head: ResponseHead<429>; data: string }
  | { kind: "task.search"; head: ResponseHead<500>; data: string }
  | { kind: "task.search"; head: ResponseHead<501>; data: string };

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

export type ScheduleSearchRes =
  | {
      kind: "schedule.search";
      head: ResponseHead<200>;
      data: { schedules: ScheduleRecord[]; cursor?: string };
    }
  | { kind: "schedule.search"; head: ResponseHead<400>; data: string }
  | { kind: "schedule.search"; head: ResponseHead<429>; data: string }
  | { kind: "schedule.search"; head: ResponseHead<500>; data: string }
  | { kind: "schedule.search"; head: ResponseHead<501>; data: string };

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
        listeners?: { id: string; address: string }[];
        tasks: TaskRecord[];
        taskTimeouts: { id: string; type: number; timeout: number }[];
        messages: { address: string; message: Message }[];
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
  | PromiseRegisterCallbackRes
  | PromiseRegisterListenerRes
  | PromiseSearchRes
  | TaskGetRes
  | TaskCreateRes
  | TaskAcquireRes
  | TaskReleaseRes
  | TaskSuspendRes
  | TaskFulfillRes
  | TaskFenceRes
  | TaskHeartbeatRes
  | TaskSearchRes
  | ScheduleGetRes
  | ScheduleCreateRes
  | ScheduleDeleteRes
  | ScheduleSearchRes
  | DebugStartRes
  | DebugResetRes
  | DebugTickRes
  | DebugSnapRes
  | DebugStopRes;

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

function isPromiseRecord(value: unknown): value is PromiseRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === "string" &&
    typeof rec.state === "string" &&
    typeof rec.tags === "object" &&
    rec.tags !== null &&
    typeof rec.timeoutAt === "number" &&
    typeof rec.createdAt === "number"
  );
}

const MESSAGE_KINDS = new Set<string>(["execute", "notify"]);

const REQUEST_KINDS = new Set<string>([
  "promise.get",
  "promise.create",
  "promise.settle",
  "promise.register_callback",
  "promise.register_listener",
  "promise.search",
  "task.get",
  "task.create",
  "task.acquire",
  "task.release",
  "task.suspend",
  "task.fulfill",
  "task.fence",
  "task.heartbeat",
  "task.search",
  "schedule.get",
  "schedule.create",
  "schedule.delete",
  "schedule.search",
  "debug.start",
  "debug.reset",
  "debug.tick",
  "debug.snap",
  "debug.stop",
]);

const RESPONSE_KINDS = REQUEST_KINDS;

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || !("head" in value) || !("data" in value)) return false;
  const { kind, data } = value as { kind: unknown; data: unknown };
  if (!MESSAGE_KINDS.has(kind as string)) return false;
  if (kind === "execute") {
    if (typeof data !== "object" || data === null) return false;
    const { task } = data as { task: unknown };
    if (typeof task !== "object" || task === null) return false;
    const { id, version } = task as { id: unknown; version: unknown };
    return typeof id === "string" && typeof version === "number";
  }
  return true;
}

export function isRequest(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || !("head" in value) || !("data" in value)) return false;
  const { kind, head } = value as { kind: unknown; head: unknown };
  if (typeof kind !== "string" || !REQUEST_KINDS.has(kind)) return false;
  if (typeof head !== "object" || head === null) return false;
  const { corrId, version } = head as { corrId: unknown; version: unknown };
  return typeof corrId === "string" && typeof version === "string";
}

export function isResponse(value: unknown): value is Response {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || !("head" in value) || !("data" in value)) return false;
  const { kind, head, data } = value as { kind: unknown; head: unknown; data: unknown };
  if (typeof kind !== "string" || !RESPONSE_KINDS.has(kind)) return false;
  if (typeof head !== "object" || head === null) return false;
  const { corrId, status, version } = head as { corrId: unknown; status: unknown; version: unknown };
  if (
    (corrId !== undefined && typeof corrId !== "string") ||
    typeof status !== "number" ||
    (version !== undefined && typeof version !== "string")
  )
    return false;
  // For error responses, data must be a string
  if (status >= 400) return typeof data === "string";
  // For success/redirect responses that carry a promise, validate the promise record
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if ("promise" in d && !isPromiseRecord(d.promise)) return false;
    if ("preload" in d && Array.isArray(d.preload) && !d.preload.every(isPromiseRecord)) return false;
  }
  return true;
}
