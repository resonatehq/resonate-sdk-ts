import { assert, assertDefined, type Promise } from "@resonatehq/dev";
import type { Encoder } from "./encoder";
import type { Encryptor } from "./encryptor";
import exceptions, { type ResonateError } from "./exceptions";
import type { Network } from "./network/network";
import type { PromiseRecord, Result, TaskRecord, Value } from "./types";

export class Cache {
  private promises: { [key: string]: PromiseRecord } = {};
  private tasks: { [key: string]: TaskRecord } = {};

  public getPromise(id: string): PromiseRecord | undefined {
    return this.promises[id];
  }

  public setPromise(promise: PromiseRecord): void {
    // do not set when promise is already completed
    if (this.promises[promise.id] !== undefined && this.promises[promise.id]?.state !== "pending") {
      return;
    }
    this.promises[promise.id] = promise;
  }

  public getTask(id: string): TaskRecord | undefined {
    return this.tasks[id];
  }

  public setTask(task: TaskRecord): void {
    // do not set when counter is greater
    if ((this.tasks[task.id]?.version || 0) >= task.version) {
      return;
    }
    this.tasks[task.id] = task;
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

  public promiseGet(id: string, done: (res: Result<PromiseRecord, ResonateError>) => void): void {
    const promise = this.cache.getPromise(id);
    if (promise) {
      done({ kind: "value", value: promise });
      return;
    }
    const corrId = crypto.randomUUID();
    this.network.send({ kind: "promise.get", head: { corrId, version: "1" }, data: { id } }, (res) => {
      if (res.kind === "error")
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, res.head.status >= 500 && res.head.status < 600),
        });
      assert(res.kind === "promise.get");
      let promise: PromiseRecord;
      try {
        promise = this.decodePromise(res.data.promise);
      } catch (e) {
        return done({ kind: "error", error: e as ResonateError });
      }

      this.cache.setPromise(promise);
      done({ kind: "value", value: promise });
    });
  }

  public promiseCreate(
    req: {
      id: string;
      param: { headers: { [key: string]: string }; data: any };
      tags: { [key: string]: string };
      timeoutAt: number;
    },
    done: (res: Result<PromiseRecord, ResonateError>) => void,
    func = "unknown",
    retryForever = false,
  ): void {
    const promise = this.cache.getPromise(req.id);
    if (promise) {
      done({ kind: "value", value: promise });
      return;
    }

    let param: Value<string>;
    try {
      param = this.encryptor.encrypt(this.encoder.encode(req.param.data));
    } catch (e) {
      done({ kind: "error", error: exceptions.ENCODING_ARGS_UNENCODEABLE(req.param.data?.func ?? func, e) });
      return;
    }

    const corrId = crypto.randomUUID();
    this.network.send(
      {
        kind: "promise.create",
        head: { version: "1", corrId },
        data: { id: req.id, param, tags: req.tags, timeoutAt: req.timeoutAt },
      },
      (res) => {
        if (res.kind === "error")
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, res.head.status >= 500 && res.head.status < 600),
          });
        assert(res.kind === "promise.create");

        let promise: PromiseRecord;
        try {
          promise = this.decodePromise(res.data.promise, req.param.data?.func ?? func);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);
        done({ kind: "value", value: promise });
      },
      retryForever,
    );
  }

  public taskCreate(
    req: {
      pid: string;
      ttl: number;
      action: {
        id: string;
        param: { headers: { [key: string]: string }; data: any };
        tags: { [key: string]: string };
        timeoutAt: number;
      };
    },
    done: (res: Result<{ promise: PromiseRecord; task?: TaskRecord }, ResonateError>) => void,
    func = "unknown",
    retryForever = false,
  ) {
    const promise = this.cache.getPromise(req.action.id);
    if (promise) {
      done({ kind: "value", value: { promise } });
      return;
    }

    let param: Value<string>;
    try {
      param = this.encryptor.encrypt(this.encoder.encode(req.action.param.data));
    } catch (e) {
      done({ kind: "error", error: exceptions.ENCODING_ARGS_UNENCODEABLE(req.action.param.data?.func ?? func, e) });
      return;
    }

    const corrId = crypto.randomUUID();
    this.network.send(
      {
        kind: "task.create",
        head: { corrId, version: "1" },
        data: {
          pid: req.pid,
          ttl: req.ttl,
          action: {
            kind: "promise.create",
            head: { corrId, version: "1" },
            data: { id: req.action.id, param, tags: req.action.tags, timeoutAt: req.action.timeoutAt },
          },
        },
      },
      (res) => {
        if (res.kind === "error")
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, res.head.status >= 500 && res.head.status < 600),
          });
        assert(res.kind === "task.create" && res.head.corrId === corrId);
        let promise: PromiseRecord;
        try {
          promise = this.decodePromise(res.data.promise, req.action.param.data?.func ?? func);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);

        const task = res.data.task;
        if (task) {
          this.cache.setTask(task);
        }

        done({ kind: "value", value: { promise, task } });
      },
      retryForever,
    );
  }

  public promiseSettle(
    req: {
      id: string;
      state: "resolved" | "rejected" | "rejected_canceled";
      value: { headers: { [key: string]: string }; data: any };
    },
    done: (res: Result<PromiseRecord, ResonateError>) => void,
    func = "unknown",
  ): void {
    const promise = this.cache.getPromise(req.id);
    assertDefined(promise);

    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }

    let value: Value<string>;
    try {
      value = this.encryptor.encrypt(this.encoder.encode(req.value?.data));
    } catch (e) {
      done({ kind: "error", error: exceptions.ENCODING_RETV_UNENCODEABLE(func, e) });
      return;
    }

    const corrId = crypto.randomUUID();
    this.network.send(
      { kind: "promise.settle", head: { corrId, version: "1" }, data: { state: req.state, id: req.id, value } },
      (res) => {
        if (res.kind === "error")
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, res.head.status >= 500 && res.head.status < 600),
          });
        assert(res.kind === "promise.settle" && res.head.corrId === corrId);

        let promise: PromiseRecord;
        try {
          promise = this.decodePromise(res.data.promise, func);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);
        done({ kind: "value", value: promise });
      },
    );
  }

  public taskAcquire(
    req: { id: string; version: number; pid: string; ttl: number },
    done: (res: Result<{ promise: PromiseRecord; preload: PromiseRecord[] }, ResonateError>) => void,
  ): void {
    const task = this.cache.getTask(req.id);
    if (task && task.version >= req.version) {
      console.log("returning an error", task, req);
      done({
        kind: "error",
        error: exceptions.SERVER_ERROR("The task version is invalid", false, {
          code: 40307,
          message: "The task version is invalid",
        }),
      });
      return;
    }

    const corrId = crypto.randomUUID();
    this.network.send({ kind: "task.acquire", head: { corrId, version: "" }, data: req }, (res) => {
      if (res.kind === "error")
        return done({
          kind: "error",
          error: exceptions.SERVER_ERROR(res.data, res.head.status >= 500 && res.head.status < 600),
        });
      assert(res.kind === "task.acquire" && res.head.corrId === corrId);

      let promise: PromiseRecord;
      try {
        promise = this.decodePromise(res.data.data.promise);
      } catch (e) {
        return done({ kind: "error", error: e as ResonateError });
      }

      this.cache.setPromise(promise);
      this.cache.setTask({ id: req.id, version: req.version });

      done({ kind: "value", value: { promise, preload: [] } });
    });
  }

  public promiseRegister(
    req: { awaiter: string; awaited: string },
    done: (res: Result<{ promise: PromiseRecord }, ResonateError>) => void,
  ): void {
    const id = `__resume:${req.awaiter}:${req.awaited}`;
    const promise = this.cache.getPromise(req.awaited);
    assertDefined(promise);

    if (promise.state !== "pending") {
      done({ kind: "value", value: { promise } });
      return;
    }

    const corrId = crypto.randomUUID();
    this.network.send(
      {
        kind: "promise.register",
        head: { corrId, version: "1" },
        data: { awaiter: req.awaiter, awaited: req.awaited },
      },
      (res) => {
        if (res.kind === "error")
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, res.head.status >= 500 && res.head.status < 600),
          });
        assert(res.kind === "promise.register" && res.head.corrId === corrId);

        if (res.data.promise) {
          let promise: PromiseRecord;
          try {
            promise = this.decodePromise(res.data.promise);
          } catch (e) {
            return done({ kind: "error", error: e as ResonateError });
          }

          this.cache.setPromise(promise);
        }

        done({
          kind: "value",
          value: { promise },
        });
      },
    );
  }

  public promiseSubscribe(
    req: { awaited: string; address: string },
    done: (res: Result<PromiseRecord, ResonateError>) => void,
    retryForever = false,
  ) {
    const id = `__notify:${req.awaited}:${req.address}`;
    const promise = this.cache.getPromise(req.awaited);
    assertDefined(promise);

    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }

    const corrId = crypto.randomUUID();
    this.network.send(
      {
        kind: "promise.subscribe",
        head: { corrId, version: "1" },
        data: { awaited: req.awaited, address: req.address },
      },
      (res) => {
        if (res.kind === "error")
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, res.head.status >= 500 && res.head.status < 600),
          });
        assert(res.kind === "promise.subscribe" && res.head.corrId === corrId);

        let promise: PromiseRecord;
        try {
          promise = this.decodePromise(res.data.promise);
        } catch (e) {
          return done({ kind: "error", error: e as ResonateError });
        }

        this.cache.setPromise(promise);

        done({ kind: "value", value: promise });
      },
      retryForever,
    );
  }

  private decodePromise(promise: Promise, func = "unknown"): PromiseRecord {
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
