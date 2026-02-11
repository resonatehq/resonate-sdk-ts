import type { Encoder } from "./encoder.js";
import type { Encryptor } from "./encryptor.js";
import exceptions, { type ResonateError } from "./exceptions.js";
import type { Network } from "./network/network.js";
import {
  isRedirect,
  isSuccess,
  type PromiseCreateReq,
  type PromiseGetReq,
  type PromiseRecord,
  type PromiseRegisterReq,
  type PromiseSettleReq,
  type PromiseSubscribeReq,
  type TaskAcquireReq,
  type TaskCreateReq,
  type TaskRecord,
  type TaskSuspendReq,
} from "./network/types.js";
import type { Result, Value } from "./types.js";
import * as util from "./util.js";

export class Cache {
  private promises: Map<string, PromiseRecord> = new Map();
  private tasks: Map<string, TaskRecord> = new Map();

  public getPromise(id: string): PromiseRecord | undefined {
    return this.promises.get(id);
  }

  public setPromise(promise: PromiseRecord): void {
    // do not set when promise is already completed
    if (this.promises.get(promise.id) !== undefined && this.promises.get(promise.id)?.state !== "pending") {
      return;
    }
    this.promises.set(promise.id, promise);
  }

  public evictPromises(ids: string[]): void {
    ids.forEach((id) => {
      if (this.getPromise(id)?.state === "pending") {
        this.promises.delete(id);
      }
    });
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

  public promiseGet(req: PromiseGetReq, done: (res: Result<PromiseRecord, ResonateError>) => void): void {
    const promise = this.cache.getPromise(req.data.id);
    if (promise) {
      done({ kind: "value", value: promise });
      return;
    }

    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data,
          }),
        });
      }

      try {
        const promise = this.decode(res.data.promise);
        this.cache.setPromise(promise);
        done({ kind: "value", value: promise });
      } catch (e) {
        return done({ kind: "error", error: e as ResonateError });
      }
    });
  }

  public promiseCreate(
    req: PromiseCreateReq,
    done: (res: Result<PromiseRecord, ResonateError>) => void,
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
      done({
        kind: "error",
        error: exceptions.ENCODING_ARGS_UNENCODEABLE((req.data.param.data as any)?.func ?? func, e),
      });
      return;
    }

    this.network.send(
      req,
      (res) => {
        if (!isSuccess(res)) {
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, {
              code: res.head.status,
              message: res.data,
            }),
          });
        }
        try {
          const promise = this.decode(res.data.promise, (req.data.param.data as any)?.func ?? func);
          this.cache.setPromise(promise);
          done({ kind: "value", value: promise });
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }
      },
      headers,
      retryForever,
    );
  }

  public taskCreate(
    req: TaskCreateReq,
    done: (res: Result<{ promise: PromiseRecord; task?: TaskRecord }, ResonateError>) => void,
    func = "unknown",
    headers: { [key: string]: string } = {},
    retryForever = false,
  ) {
    let param: Value<string>;
    try {
      param = this.encryptor.encrypt(this.encoder.encode(req.data.action.data.param.data));
    } catch (e) {
      done({
        kind: "error",
        error: exceptions.ENCODING_ARGS_UNENCODEABLE((req.data.action.data.param.data as any)?.func ?? func, e),
      });
      return;
    }

    req.data.action.data.param = param;
    this.network.send(
      req,
      (res) => {
        if (!isSuccess(res)) {
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, {
              code: res.head.status,
              message: res.data,
            }),
          });
        }

        let promise: PromiseRecord;
        try {
          promise = this.decode(res.data.promise, (req.data.action.data.param.data as any)?.func ?? func);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);

        done({ kind: "value", value: { promise, task: res.data.task } });
      },
      headers,
      retryForever,
    );
  }

  public promiseSettle(
    req: PromiseSettleReq,
    done: (res: Result<PromiseRecord, ResonateError>) => void,
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
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data,
          }),
        });
      }

      let promise: PromiseRecord;
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
    done: (res: Result<{ task: TaskRecord; root: PromiseRecord }, ResonateError>) => void,
  ): void {
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data,
          }),
        });
      }

      let promise: PromiseRecord;

      try {
        promise = this.decode(res.data.promise);
      } catch (e) {
        return done({ kind: "error", error: e as ResonateError });
      }

      this.cache.setPromise(promise);

      const task: TaskRecord = { id: req.data.id, state: "acquired", version: req.data.version };
      done({ kind: "value", value: { task, root: promise } });
    });
  }
  public taskSuspend(req: TaskSuspendReq, done: (res: Result<{ continue: boolean }, ResonateError>) => void): void {
    this.cache.evictPromises(req.data.actions.map((a) => a.data.awaited));
    this.network.send(req, (res) => {
      if (isSuccess(res)) {
        return done({
          kind: "value",
          value: { continue: false },
        });
      } else if (isRedirect(res)) {
        return done({
          kind: "value",
          value: { continue: true },
        });
      } else {
        done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data,
          }),
        });
      }
    });
  }

  public promiseRegister(
    req: PromiseRegisterReq,
    done: (res: Result<PromiseRecord, ResonateError>) => void,
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
        if (!isSuccess(res)) {
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, {
              code: res.head.status,
              message: res.data,
            }),
          });
        }

        if (res.data.promise) {
          let promise: PromiseRecord;
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
    done: (res: Result<PromiseRecord, ResonateError>) => void,
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
        if (!isSuccess(res)) {
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, {
              code: res.head.status,
              message: res.data,
            }),
          });
        }

        let promise: PromiseRecord;
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

  public encodeValue(data: any, func: string): Result<Value<string>, ResonateError> {
    try {
      return { kind: "value", value: this.encryptor.encrypt(this.encoder.encode(data)) };
    } catch (e) {
      return { kind: "error", error: exceptions.ENCODING_RETV_UNENCODEABLE(func, e) };
    }
  }

  private decode(promise: PromiseRecord, func = "unknown"): PromiseRecord {
    let paramData: any;
    let valueData: any;

    try {
      paramData = this.encoder.decode(this.encryptor.decrypt(promise.param as Value<string>));
    } catch (e) {
      console.error(e);
      throw exceptions.ENCODING_ARGS_UNDECODEABLE(paramData?.func ?? func, e);
    }

    try {
      valueData = this.encoder.decode(this.encryptor.decrypt(promise.value as Value<string>));
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
