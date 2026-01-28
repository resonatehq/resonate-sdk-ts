// Records
export type PromiseState = "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";

export type PromiseRecord<T> = {
  id: string;
  state: PromiseState;
  param: { headers: { [key: string]: string }; data: T };
  value: { headers: { [key: string]: string }; data: T };
  tags: { [key: string]: string };
  timeoutAt: number;
  createdAt: number;
  settledAt?: number;
};

export type TaskRecord = {
  id: string;
  version: number;
};

export type InvokeMessage = {
  kind: "invoke";
  head: { [key: string]: string };
  data: {
    task: TaskRecord;
  };
};

export type ResumeMessage = {
  kind: "resume";
  head: { [key: string]: string };
  data: {
    task: TaskRecord;
  };
};

export type NotifyMessage = {
  kind: "notify";
  head: { [key: string]: string };
  data: {
    promise: PromiseRecord<string>;
  };
};

export type Message = InvokeMessage | ResumeMessage | NotifyMessage;

export type ScheduleRecord<T> = {
  id: string;
  cron: string;
  promiseId: string;
  promiseTimeout: number;
  promiseParam: { headers: { [key: string]: string }; data: T };
  promiseTags: { [key: string]: string };
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
};

type ReqResKind =
  | "promise.get"
  | "promise.create"
  | "promise.settle"
  | "promise.register"
  | "promise.subscribe"
  | "task.get"
  | "task.create"
  | "task.acquire"
  | "task.suspend"
  | "task.fulfill"
  | "task.release"
  | "task.fence"
  | "task.heartbeat"
  | "schedule.get"
  | "schedule.create"
  | "schedule.delete"
  | "error";

type ReqSchema<K extends ReqResKind, T> = {
  kind: K;
  head: {
    auth?: string;
    corrId: string;
    version: string;
  };
  data: T;
};

type ResSchema<K extends ReqResKind, S extends number, T> = {
  kind: K;
  head: {
    corrId: string;
    status: S;
    version: string;
  };
  data: T;
};

export type ErrorCode = 400 | 404 | 409 | 429 | 500;
export type ErrorRes = ResSchema<"error", ErrorCode, string>;

export type PromiseGetReq = ReqSchema<"promise.get", { id: string }>;
export type PromiseGetRes = ResSchema<"promise.get", 200, { promise: PromiseRecord<string> }>;

export type PromiseCreateReq<T> = ReqSchema<
  "promise.create",
  {
    id: string;
    param: { headers: { [key: string]: string }; data: T };
    tags: { [key: string]: string };
    timeoutAt: number;
  }
>;
export type PromiseCreateRes = ResSchema<"promise.create", 200, { promise: PromiseRecord<string> }>;

export type PromiseSettleReq<T> = ReqSchema<
  "promise.settle",
  {
    id: string;
    state: "resolved" | "rejected" | "rejected_canceled";
    value: { headers: { [key: string]: string }; data: T };
  }
>;
export type PromiseSettleRes = ResSchema<"promise.settle", 200, { promise: PromiseRecord<string> }>;

export type PromiseRegisterReq = ReqSchema<"promise.register", { awaiter: string; awaited: string }>;
export type PromiseRegisterRes = ResSchema<"promise.register", 200, { promise: PromiseRecord<string> }>;

export type PromiseSubscribeReq = ReqSchema<"promise.subscribe", { awaited: string; address: string }>;
export type PromiseSubscribeRes = ResSchema<"promise.subscribe", 200, { promise: PromiseRecord<string> }>;

export type TaskGetReq = ReqSchema<"task.get", { id: string }>;
export type TaskGetRes = ResSchema<"task.get", 200, { task: TaskRecord }>;

export type TaskCreateReq<T> = ReqSchema<"task.create", { pid: string; ttl: number; action: PromiseCreateReq<T> }>;
export type TaskCreateRes = ResSchema<"task.create", 200, { task?: TaskRecord; promise: PromiseRecord<string> }>;

export type TaskAcquireReq = ReqSchema<"task.acquire", { id: string; version: number; pid: string; ttl: number }>;
export type TaskAcquireRes = ResSchema<
  "task.acquire",
  200,
  { kind: "invoke" | "resume"; data: { promise: PromiseRecord<string>; preload: PromiseRecord<string>[] } }
>;

export type TaskSuspendReq = ReqSchema<
  "task.suspend",
  {
    id: string;
    version: number;
    actions: PromiseRegisterReq[];
  }
>;
export type TaskSuspendRes = ResSchema<"task.suspend", 200 | 300, undefined>;

export type TaskFulfillReq<T> = ReqSchema<
  "task.fulfill",
  {
    id: string;
    version: number;
    action: PromiseSettleReq<T>;
  }
>;
export type TaskFulfillRes = ResSchema<"task.fulfill", 200, { promise: PromiseRecord<string> }>;

export type TaskReleaseReq = ReqSchema<"task.release", { id: string; version: number }>;
export type TaskReleaseRes = ResSchema<"task.release", 200, undefined>;

export type TaskFenceReq<T> = ReqSchema<
  "task.fence",
  {
    id: string;
    version: number;
    action: PromiseCreateReq<T> | PromiseSettleReq<T>;
  }
>;
export type TaskFenceRes = ResSchema<"task.fence", 200, { action: PromiseCreateRes | PromiseSettleRes }>;

export type TaskHeartbeatReq = ReqSchema<"task.heartbeat", { pid: string; tasks: TaskRecord[] }>;
export type TaskHeartbeatRes = ResSchema<"task.heartbeat", 200, undefined>;

export type ScheduleGetReq = ReqSchema<"schedule.get", { id: string }>;
export type ScheduleGetRes = ResSchema<"schedule.get", 200, { schedule: ScheduleRecord<string> }>;

export type ScheduleCreateReq<T> = ReqSchema<
  "schedule.create",
  {
    id: string;
    cron: string;
    promiseId: string;
    promiseTimeout: number;
    promiseParam: { headers: { [key: string]: string }; data: T };
    promiseTags: { [key: string]: string };
  }
>;
export type ScheduleCreateRes = ResSchema<"schedule.create", 200, { schedule: ScheduleRecord<string> }>;

export type ScheduleDeleteReq = ReqSchema<"schedule.delete", { id: string }>;
export type ScheduleDeleteRes = ResSchema<"schedule.delete", 200, undefined>;

export type Req<T> =
  | PromiseGetReq
  | PromiseCreateReq<T>
  | PromiseSettleReq<T>
  | PromiseRegisterReq
  | PromiseSubscribeReq
  | TaskGetReq
  | TaskCreateReq<T>
  | TaskAcquireReq
  | TaskSuspendReq
  | TaskFulfillReq<T>
  | TaskReleaseReq
  | TaskFenceReq<T>
  | TaskHeartbeatReq
  | ScheduleGetReq
  | ScheduleCreateReq<T>
  | ScheduleDeleteReq;

export type Res =
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
  | ErrorRes;

export interface Network {
  start(): void;
  stop(): void;

  send(
    req: Req<string>,
    callback: (res: Res) => void,
    headers?: { [key: string]: string },
    retryForever?: boolean,
  ): void;
  getMessageSource?: () => MessageSource;
}

export interface MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  start(): void;
  stop(): void;

  recv(msg: Message): void;
  subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Message) => void): void;
  match(target: string): string;
}
