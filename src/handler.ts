import type { Encoder } from "./encoder";
import type { Encryptor } from "./encryptor";
import exceptions, { type ResonateError } from "./exceptions";
import type {
  Network,
  PromiseCreateReq,
  PromiseGetReq,
  PromiseRecord,
  PromiseRegisterReq,
  PromiseSettleReq,
  PromiseSubscribeReq,
  TaskAcquireReq,
  TaskCreateReq,
  TaskRecord,
} from "./network/network";
import type { Result, Value } from "./types";
import * as util from "./util";

export class Cache {
  private promises: Map<string, PromiseRecord<any>> = new Map();
  private tasks: Map<string, TaskRecord> = new Map();

  public getPromise(id: string): PromiseRecord<any> | undefined {
    return this.promises.get(id);
  }

  public setPromise(promise: PromiseRecord<any>): void {
    // do not set when promise is already completed
    if (this.promises.get(promise.id) !== undefined && this.promises.get(promise.id)?.state !== "pending") {
      return;
    }
    this.promises.set(promise.id, promise);
  }
  public getTask(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  public setTask(task: TaskRecord): void {
    // do not set when counter is greater
    if ((this.tasks.get(task.id)?.version || 0) >= task.version) {
      return;
    }
    this.tasks.set(task.id, task);
  }
}

export class Handler {
  private cache: Cache = new Cache();
  private network: Network;
  private encoder: Encoder;
  private encryptor: Encryptor;

  constructor(network: Network, encoder: Encoder, encryptor: Encryptor) {
    this.network = network;
    this.encoder = encoder;
    this.encryptor = encryptor;
  }

  public promiseGet(req: PromiseGetReq, done: (res: Result<PromiseRecord<any>, ResonateError>) => void): void {
    const promise = this.cache.getPromise(req.data.id);
    if (promise) {
      done({ kind: "value", value: promise });
      return;
    }

    this.network.send(req, (res) => {
      if (res.kind === "error")
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, true, { code: res.head.status, message: res.data }),
        });
      util.assert(res.kind === "promise.get");
      let promise: PromiseRecord<any>;
      try {
        promise = this.decode(res.data.promise);
      } catch (e) {
        return done({ kind: "error", error: e as ResonateError });
      }

      this.cache.setPromise(promise);
      done({ kind: "value", value: promise });
    });
  }

  public promiseCreate(
    req: PromiseCreateReq<any>,
    done: (res: Result<PromiseRecord<any>, ResonateError>) => void,
    func = "unknown",
    headers: { [key: string]: string } = {},
    retryForever = false,
  ): void {
    const promise = this.cache.getPromise(req.data.id);
    if (promise) {
      done({ kind: "value", value: promise });
      return;
    }
    let param: Value<string>;
    try {
      param = this.encryptor.encrypt(this.encoder.encode(req.data.param.data));
      req.data.param = param;
    } catch (e) {
      done({ kind: "error", error: exceptions.ENCODING_ARGS_UNENCODEABLE(req.data.param.data?.func ?? func, e) });
      return;
    }

    this.network.send(
      req,
      (res) => {
        if (res.kind === "error")
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, { code: res.head.status, message: res.data }),
          });
        util.assert(res.kind === "promise.create");
        let promise: PromiseRecord<any>;
        try {
          promise = this.decode(res.data.promise, req.data.param.data?.func ?? func);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);
        done({ kind: "value", value: promise });
      },
      headers,
      retryForever,
    );
  }

  public taskCreate(
    req: TaskCreateReq<any>,
    done: (res: Result<{ promise: PromiseRecord<any>; task?: TaskRecord }, ResonateError>) => void,
    func = "unknown",
    headers: { [key: string]: string } = {},
    retryForever = false,
  ) {
    const promise = this.cache.getPromise(req.data.action.data.id);
    if (promise) {
      done({ kind: "value", value: { promise } });
      return;
    }

    let param: Value<string>;
    try {
      param = this.encryptor.encrypt(this.encoder.encode(req.data.action.data.param.data));
    } catch (e) {
      done({
        kind: "error",
        error: exceptions.ENCODING_ARGS_UNENCODEABLE(req.data.action.data.param.data?.func ?? func, e),
      });
      return;
    }

    req.data.action.data.param = param;
    this.network.send(
      req,
      (res) => {
        if (res.kind === "error")
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, { code: res.head.status, message: res.data }),
          });
        util.assert(res.kind === "task.create");
        let promise: PromiseRecord<any>;
        try {
          promise = this.decode(res.data.promise, req.data.action.data.param.data?.func ?? func);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);

        if (res.data.task) {
          this.cache.setTask(res.data.task);
        }

        done({ kind: "value", value: { promise, task: res.data.task } });
      },
      headers,
      retryForever,
    );
  }

  public promiseSettle(
    req: PromiseSettleReq<any>,
    done: (res: Result<PromiseRecord<any>, ResonateError>) => void,
    func = "unknown",
  ): void {
    const promise = this.cache.getPromise(req.data.id);
    util.assertDefined(promise);

    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }

    let value: Value<string>;
    try {
      value = this.encryptor.encrypt(this.encoder.encode(req.data.value.data));
      req.data.value = value;
    } catch (e) {
      done({ kind: "error", error: exceptions.ENCODING_RETV_UNENCODEABLE(func, e) });
      return;
    }

    this.network.send(req, (res) => {
      if (res.kind === "error") {
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, true, { code: res.head.status, message: res.data }),
        });
      }
      util.assert(res.kind === req.kind);
      let promise: PromiseRecord<any>;
      try {
        promise = this.decode(res.data.promise, func);
      } catch (e) {
        return done({ kind: "error", error: e as ResonateError });
      }

      this.cache.setPromise(promise);
      done({ kind: "value", value: promise });
    });
  }

  public taskAcquire(
    req: TaskAcquireReq,
    done: (res: Result<{ root: PromiseRecord<any> }, ResonateError>) => void,
  ): void {
    const task = this.cache.getTask(req.data.id);
    if (task && task.version >= req.data.version) {
      done({
        kind: "error",
        error: exceptions.ENCODING_RETV_UNDECODEABLE("The task counter is invalid", {
          code: 40307,
          message: "The task counter is invalid",
        }),
      });
      return;
    }

    this.network.send(req, (res) => {
      if (res.kind === "error")
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, true, { code: res.head.status, message: res.data }),
        });
      util.assert(res.kind === req.kind);

      let promise: PromiseRecord<any>;

      try {
        promise = this.decode(res.data.data.promise);
      } catch (e) {
        return done({ kind: "error", error: e as ResonateError });
      }

      this.cache.setPromise(promise);
      this.cache.setTask({ id: req.data.id, version: req.data.version });

      done({ kind: "value", value: { root: promise } });
    });
  }

  public promiseRegister(
    req: PromiseRegisterReq,
    done: (res: Result<PromiseRecord<any>, ResonateError>) => void,
    headers: { [key: string]: string } = {},
  ): void {
    const id = `__resume:${req.data.awaiter}:${req.data.awaited}`;
    const promise = this.cache.getPromise(req.data.awaited);
    util.assertDefined(promise);

    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }

    this.network.send(
      req,
      (res) => {
        if (res.kind === "error") {
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, { code: res.head.status, message: res.data }),
          });
        }
        util.assert(req.kind === res.kind);
        if (res.data.promise) {
          let promise: PromiseRecord<any>;
          try {
            promise = this.decode(res.data.promise);
          } catch (e) {
            return done({ kind: "error", error: e as ResonateError });
          }

          this.cache.setPromise(promise);
        }
        done({ kind: "value", value: promise });
      },
      headers,
    );
  }

  public promiseSubscribe(
    req: PromiseSubscribeReq,
    done: (res: Result<PromiseRecord<any>, ResonateError>) => void,
    retryForever = false,
  ) {
    const id = `__notify:${req.data.awaited}:${req.data.address}`;
    const promise = this.cache.getPromise(req.data.awaited);
    util.assertDefined(promise);

    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }

    this.network.send(
      req,
      (res) => {
        if (res.kind === "error") {
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, { code: res.head.status, message: res.data }),
          });
        }
        util.assert(req.kind === res.kind);
        let promise: PromiseRecord<any>;
        try {
          promise = this.decode(res.data.promise);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);

        done({ kind: "value", value: promise });
      },
      {},
      retryForever,
    );
  }

  private decode(promise: PromiseRecord<string>, func = "unknown"): PromiseRecord<any> {
    let paramData: any;
    let valueData: any;

    try {
      paramData = this.encoder.decode(this.encryptor.decrypt(promise.param));
    } catch (e) {
      throw exceptions.ENCODING_ARGS_UNDECODEABLE(func, e);
    }

    try {
      valueData = this.encoder.decode(this.encryptor.decrypt(promise.value));
    } catch (e) {
      throw exceptions.ENCODING_RETV_UNDECODEABLE(paramData?.func ?? func, e);
    }

    return {
      ...promise,
      param: { headers: promise.param?.headers, data: paramData },
      value: { headers: promise.value?.headers, data: valueData },
    };
  }
}
