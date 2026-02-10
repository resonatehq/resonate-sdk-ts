// Models

export type PromiseRecord = {
  id: string;
  state: PromiseState;
  param: { headers: { [key: string]: string }; data: any };
  value: { headers: { [key: string]: string }; data: any };
  tags: { [key: string]: string };
  timeoutAt: number;
  createdAt: number;
  settledAt?: number;
};

export type PromiseState = "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";

export type TaskRecord = {
  id: string;
  version: number;
};

export type ScheduleRecord = {
  id: string;
  cron: string;
  promiseId: string;
  promiseTimeout: number;
  promiseParam: { headers: { [key: string]: string }; data: any };
  promiseTags: { [key: string]: string };
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
};

// Requests

export type Req =
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
  | ScheduleDeleteReq;

export type PromiseGetReq = {
  kind: "promise.get";
  head: { auth?: string; corrId: string; version: string };
  data: { id: string };
};

export type PromiseCreateReq = {
  kind: "promise.create";
  head: { auth?: string; corrId: string; version: string };
  data: {
    id: string;
    param: { headers: { [key: string]: string }; data: any };
    tags: { [key: string]: string };
    timeoutAt: number;
  };
};

export type PromiseSettleReq = {
  kind: "promise.settle";
  head: { auth?: string; corrId: string; version: string };
  data: {
    id: string;
    state: "resolved" | "rejected" | "rejected_canceled";
    value: { headers: { [key: string]: string }; data: any };
  };
};

export type PromiseRegisterReq = {
  kind: "promise.register";
  head: { auth?: string; corrId: string; version: string };
  data: { awaiter: string; awaited: string };
};

export type PromiseSubscribeReq = {
  kind: "promise.subscribe";
  head: { auth?: string; corrId: string; version: string };
  data: { awaited: string; address: string };
};

export type TaskGetReq = {
  kind: "task.get";
  head: { auth?: string; corrId: string; version: string };
  data: { id: string };
};

export type TaskCreateReq = {
  kind: "task.create";
  head: { auth?: string; corrId: string; version: string };
  data: { pid: string; ttl: number; action: PromiseCreateReq };
};

export type TaskAcquireReq = {
  kind: "task.acquire";
  head: { auth?: string; corrId: string; version: string };
  data: { id: string; version: number; pid: string; ttl: number };
};

export type TaskSuspendReq = {
  kind: "task.suspend";
  head: { auth?: string; corrId: string; version: string };
  data: {
    id: string;
    version: number;
    actions: PromiseRegisterReq[];
  };
};

export type TaskFulfillReq = {
  kind: "task.fulfill";
  head: { auth?: string; corrId: string; version: string };
  data: {
    id: string;
    version: number;
    action: PromiseSettleReq;
  };
};

export type TaskReleaseReq = {
  kind: "task.release";
  head: { auth?: string; corrId: string; version: string };
  data: { id: string; version: number };
};

export type TaskFenceReq = {
  kind: "task.fence";
  head: { auth?: string; corrId: string; version: string };
  data: {
    id: string;
    version: number;
    action: PromiseCreateReq | PromiseSettleReq;
  };
};

export type TaskHeartbeatReq = {
  kind: "task.heartbeat";
  head: { auth?: string; corrId: string; version: string };
  data: { pid: string; tasks: TaskRecord[] };
};

export type ScheduleGetReq = {
  kind: "schedule.get";
  head: { auth?: string; corrId: string; version: string };
  data: { id: string };
};

export type ScheduleCreateReq = {
  kind: "schedule.create";
  head: { auth?: string; corrId: string; version: string };
  data: {
    id: string;
    cron: string;
    promiseId: string;
    promiseTimeout: number;
    promiseParam: { headers: { [key: string]: string }; data: any };
    promiseTags: { [key: string]: string };
  };
};

export type ScheduleDeleteReq = {
  kind: "schedule.delete";
  head: { auth?: string; corrId: string; version: string };
  data: { id: string };
};

// Responses

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
  | ScheduleDeleteRes;

export type PromiseGetRes =
  | {
      kind: "promise.get";
      head: { corrId: string; status: 200; version: string };
      data: { promise: PromiseRecord };
    }
  | {
      kind: "promise.get";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "promise.get";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type PromiseCreateRes =
  | {
      kind: "promise.create";
      head: { corrId: string; status: 200; version: string };
      data: { promise: PromiseRecord };
    }
  | {
      kind: "promise.create";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type PromiseSettleRes =
  | {
      kind: "promise.settle";
      head: { corrId: string; status: 200; version: string };
      data: { promise: PromiseRecord };
    }
  | {
      kind: "promise.settle";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "promise.settle";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type PromiseRegisterRes =
  | {
      kind: "promise.register";
      head: { corrId: string; status: 200; version: string };
      data: { promise: PromiseRecord };
    }
  | {
      kind: "promise.register";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "promise.register";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type PromiseSubscribeRes =
  | {
      kind: "promise.subscribe";
      head: { corrId: string; status: 200; version: string };
      data: { promise: PromiseRecord };
    }
  | {
      kind: "promise.subscribe";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "promise.subscribe";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskGetRes =
  | {
      kind: "task.get";
      head: { corrId: string; status: 200; version: string };
      data: { task: TaskRecord };
    }
  | {
      kind: "task.get";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "task.get";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskCreateRes =
  | {
      kind: "task.create";
      head: { corrId: string; status: 200; version: string };
      data: { task?: TaskRecord; promise: PromiseRecord };
    }
  | {
      kind: "task.create";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskAcquireRes =
  | {
      kind: "task.acquire";
      head: { corrId: string; status: 200; version: string };
      data: {
        kind: "invoke" | "resume";
        data: { promise: PromiseRecord; preload: PromiseRecord[] };
      };
    }
  | {
      kind: "task.acquire";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "task.acquire";
      head: { corrId: string; status: 409; version: string };
      data: string;
    }
  | {
      kind: "task.acquire";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskSuspendRes =
  | {
      kind: "task.suspend";
      head: { corrId: string; status: 200; version: string };
      data: undefined;
    }
  | {
      kind: "task.suspend";
      head: { corrId: string; status: 300; version: string };
      data: undefined;
    }
  | {
      kind: "task.suspend";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "task.suspend";
      head: { corrId: string; status: 409; version: string };
      data: string;
    }
  | {
      kind: "task.suspend";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskFulfillRes =
  | {
      kind: "task.fulfill";
      head: { corrId: string; status: 200; version: string };
      data: { promise: PromiseRecord };
    }
  | {
      kind: "task.fulfill";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "task.fulfill";
      head: { corrId: string; status: 409; version: string };
      data: string;
    }
  | {
      kind: "task.fulfill";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskReleaseRes =
  | {
      kind: "task.release";
      head: { corrId: string; status: 200; version: string };
      data: undefined;
    }
  | {
      kind: "task.release";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "task.release";
      head: { corrId: string; status: 409; version: string };
      data: string;
    }
  | {
      kind: "task.release";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskFenceRes =
  | {
      kind: "task.fence";
      head: { corrId: string; status: 200; version: string };
      data: { action: PromiseCreateRes | PromiseSettleRes };
    }
  | {
      kind: "task.fence";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "task.fence";
      head: { corrId: string; status: 409; version: string };
      data: string;
    }
  | {
      kind: "task.fence";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type TaskHeartbeatRes =
  | {
      kind: "task.heartbeat";
      head: { corrId: string; status: 200; version: string };
      data: undefined;
    }
  | {
      kind: "task.heartbeat";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "task.heartbeat";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type ScheduleGetRes =
  | {
      kind: "schedule.get";
      head: { corrId: string; status: 200; version: string };
      data: { schedule: ScheduleRecord };
    }
  | {
      kind: "schedule.get";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "schedule.get";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type ScheduleCreateRes =
  | {
      kind: "schedule.create";
      head: { corrId: string; status: 200; version: string };
      data: { schedule: ScheduleRecord };
    }
  | {
      kind: "schedule.create";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

export type ScheduleDeleteRes =
  | {
      kind: "schedule.delete";
      head: { corrId: string; status: 200; version: string };
      data: undefined;
    }
  | {
      kind: "schedule.delete";
      head: { corrId: string; status: 404; version: string };
      data: string;
    }
  | {
      kind: "schedule.delete";
      head: { corrId: string; status: 500; version: string };
      data: string;
    };

// Messages

export type Msg = ExecuteMsg | NotifyMsg;

export type ExecuteMsg = {
  kind: "execute";
  head: {
    serverUrl?: string;
  };
  data: {
    task: TaskRecord;
  };
};

export type NotifyMsg = {
  kind: "notify";
  head: {};
  data: {
    promise: PromiseRecord;
  };
};

// Type Guards

export function isSuccess<T extends Res>(res: T): res is Extract<T, { head: { status: 200 } }> {
  return res.head.status === 200;
}

export function isNotFound<T extends Res>(res: T): res is Extract<T, { head: { status: 404 } }> {
  return res.head.status === 404;
}

export function isConflict<T extends Res>(res: T): res is Extract<T, { head: { status: 409 } }> {
  return res.head.status === 409;
}

export function isRedirect<T extends Res>(res: T): res is Extract<T, { head: { status: 300 } }> {
  return res.head.status === 300;
}

export function isError<T extends Res>(res: T): res is Extract<T, { head: { status: 500 } }> {
  return res.head.status === 500;
}
