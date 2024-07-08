import { JSONEncoder } from "./core/encoders/json";
import { ErrorCodes, ResonateError } from "./core/errors";
import { Logger } from "./core/loggers/logger";
import { PartialOptions, Options, InvocationOverrides, ResonateOptions } from "./core/options";
import { DurablePromiseRecord } from "./core/promises/types";
import * as retryPolicies from "./core/retry";
import { runWithRetry } from "./core/retry";
import { IPromiseStore, IStore } from "./core/store";
import { LocalStore } from "./core/stores/local";
import { RemoteStore } from "./core/stores/remote";
import * as utils from "./core/utils";
import { sleep } from "./core/utils";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type InvocationData = {
  id: string;
  eid: string;
  name: string;
  version: number;
};

// The type of a resonate function
export type Func = (ctx: Context, ...args: any[]) => any;

// The args of a resonate function excluding the context argument
export type Params<F> = F extends (ctx: any, ...args: infer P) => any ? P : never;

// The return type of a resonate function
export type Return<F> = F extends (...args: any[]) => infer T ? Awaited<T> : never;

export class Resonate {
  #store: IStore;
  #registeredFunctions: Record<string, Record<number, { func: Func; opts: Options }>> = {};
  defaultInvocationOptions: Options;

  constructor({
    auth = undefined,
    encoder = new JSONEncoder(),
    heartbeat = 15000, // 15s
    logger = new Logger(),
    pid = utils.randomId(),
    pollFrequency = 5000, // 5s
    retryPolicy = retryPolicies.exponential(),
    store = undefined,
    tags = {},
    timeout = 10000, // 10s
    url = undefined,
  }: Partial<ResonateOptions> = {}) {
    if (store) {
      this.#store = store;
    } else if (url) {
      this.#store = new RemoteStore(url, {
        auth,
        heartbeat,
        logger,
        pid,
      });
    } else {
      this.#store = new LocalStore({
        auth,
        heartbeat,
        logger,
        pid,
      });
    }

    this.defaultInvocationOptions = {
      __resonate: true,
      durable: true,
      eidFn: utils.randomId,
      encoder: encoder,
      idempotencyKeyFn: utils.hash,
      shouldLock: undefined,
      pollFrequency,
      retryPolicy,
      tags,
      timeout,
      version: 0,
    };
  }

  get promiseStore() {
    return this.#store.promises;
  }

  get locksStore() {
    return this.#store.locks;
  }

  registeredFunction(funcName: string, version: number): { func: Func; opts: Options } {
    if (!this.#registeredFunctions[funcName]?.[version]) {
      throw new Error(`Function ${funcName} version ${version} not registered`);
    }

    return this.#registeredFunctions[funcName][version];
  }

  register(name: string, func: Func, opts: Partial<Options> = {}): void {
    // set default version
    opts.version = opts.version ?? 1;

    // set default values for the options options
    const options = this.withDefaultOpts(opts);

    if (options.version <= 0) {
      throw new Error("Version must be greater than 0");
    }

    if (!this.#registeredFunctions[name]) {
      this.#registeredFunctions[name] = {};
    }

    if (this.#registeredFunctions[name][options.version]) {
      throw new Error(`Function ${name} version ${options.version} already registered`);
    }

    // Get the highest version number of existing functions with this name
    const latestVersion = Math.max(...Object.values(this.#registeredFunctions[name]).map((f) => f.opts.version));

    // If the new function's version is higher, register it as the latest (index 0)
    if (options.version > latestVersion) {
      this.#registeredFunctions[name][0] = { func, opts: options };
    }

    // register specific version
    this.#registeredFunctions[name][options.version] = { func, opts: options };
  }

  async run<R>(name: string, id: string, args: any[], givenOpts: InvocationOverrides): Promise<R> {
    const handle = await this.invokeLocal<R>(name, id, args, givenOpts);
    return handle.result();
  }

  async invokeLocal<R>(
    name: string,
    id: string,
    args: any[],
    optionOverrides: InvocationOverrides,
  ): Promise<InvocationHandle<R>> {
    // version 0 means the latest registered version
    const givenVersion = optionOverrides?.version ?? 0;

    // guarantees we only use the overrides in case the user pass an object with more properties
    const { eidFn, idempotencyKeyFn, retryPolicy, tags, timeout, version } = optionOverrides;
    const { func, opts: registeredOpts } = this.registeredFunction(name, givenVersion);

    const opts: Options = utils.mergeObjects(
      {
        eidFn,
        idempotencyKeyFn,
        retryPolicy,
        tags,
        timeout,
        version,
      },
      registeredOpts,
    );

    // We want to preserve the registered version.
    opts.version = registeredOpts.version;

    // For tags we need to merge the objects themselves
    // giving priority to the passed tags and add the
    // resonate:invocation tag to identify a top level invocation
    opts.tags = { ...registeredOpts.tags, ...tags, "resonate:invocation": "true" };

    // lock on top level is true by default
    opts.shouldLock = opts.shouldLock ?? true;

    const param = {
      func: name,
      version: opts.version,
      retryPolicy: opts.retryPolicy,
      args,
    };

    const idempotencyKey = opts.idempotencyKeyFn(id);
    const storedPromise: DurablePromiseRecord = await this.promiseStore.create(
      id,
      idempotencyKey,
      false,
      undefined,
      opts.encoder.encode(param),
      Date.now() + opts.timeout,
      opts.tags,
    );

    const runFunc = async (): Promise<R> => {
      const eid = opts.eidFn(id);
      let value!: R;

      // If the promise that comes back from the server is already completed, resolve or reject right away.
      switch (storedPromise.state) {
        case "RESOLVED":
          return opts.encoder.decode(storedPromise.value.data) as R;
        case "REJECTED":
          throw new ResonateError(
            "Error in user function",
            ErrorCodes.USER,
            opts.encoder.decode(storedPromise.value.data),
          );
        case "REJECTED_CANCELED":
          throw new ResonateError(
            "Resonate function canceled",
            ErrorCodes.CANCELED,
            opts.encoder.decode(storedPromise.value.data),
          );
        case "REJECTED_TIMEDOUT":
          throw new ResonateError(
            `Resonate function timedout at ${new Date(storedPromise.timeout).toISOString()}`,
            ErrorCodes.TIMEDOUT,
          );
      }

      // storedPromise.state === "PENDING"
      try {
        // Acquire the lock if necessary
        if (opts.shouldLock) {
          const acquireLock = async (): Promise<boolean> => {
            try {
              return await this.#store.locks.tryAcquire(id, eid);
            } catch (e: unknown) {
              // if lock is already acquired, return false so we can poll
              if (e instanceof ResonateError && e.code === ErrorCodes.STORE_FORBIDDEN) {
                return false;
              }

              throw e;
            }
          };
          while (!(await acquireLock())) {
            await sleep(opts.pollFrequency);
          }
        }

        let error: any;
        const ctx = Context.createRootContext(this, { id, eid, name, version: opts.version });

        // we need to hold on to a boolean to determine if the function was successful,
        // we cannot rely on the value or error as these values could be undefined
        let success = true;
        try {
          value = await runWithRetry(() => func(ctx, ...args), opts.retryPolicy, storedPromise.timeout);
        } catch (e) {
          // We need to capture the error to be able to reject the durable promise
          // after that we will then propagate this error by rejecting the result promise
          error = e;
          success = false;
        }

        let completedPromiseRecord!: DurablePromiseRecord;
        if (success) {
          completedPromiseRecord = await this.promiseStore.resolve(
            id,
            idempotencyKey,
            false,
            storedPromise.value.headers,
            opts.encoder.encode(value),
          );
        } else {
          completedPromiseRecord = await this.promiseStore.reject(
            id,
            idempotencyKey,
            false,
            storedPromise.value.headers,
            opts.encoder.encode(error),
          );
        }

        // Because of eventual consistency and recovery paths it is possible that we get a
        // rejected promise even if we did call `resolve` on it or the other way around.
        // What should never happen is that we get a "PENDING" promise
        switch (completedPromiseRecord.state) {
          case "RESOLVED":
            return value as R;
          case "REJECTED":
            throw new ResonateError("Resonate function errror", ErrorCodes.USER, error);
          case "REJECTED_CANCELED":
            throw new ResonateError("Resonate function canceled", ErrorCodes.CANCELED, error);
          case "REJECTED_TIMEDOUT":
            throw new ResonateError(
              `Resonate function timedout at ${new Date(completedPromiseRecord.timeout).toISOString()}`,
              ErrorCodes.TIMEDOUT,
            );
          case "PENDING":
            throw new Error("Unreachable");
        }
      } catch (err) {
        if (err instanceof ResonateError && err.code === ErrorCodes.USER) {
          // When it is an error in the function provided by the error unwrap the error and return it as is
          throw err.cause;
        } else if (
          err instanceof ResonateError &&
          (err.code === ErrorCodes.CANCELED || err.code === ErrorCodes.TIMEDOUT)
        ) {
          // Cancel and timeout errors just forward them
          throw err;
        } else {
          // All other errors, including resonte STORE errors and UNKNOWN errors or
          // errors that happened during fetch, for example the server was unreachable.

          // Kill this top level invocation and throw the error
          throw err;
        }
      } finally {
        // release lock if necessary
        if (opts.shouldLock) {
          await this.locksStore.release(id, eid);
        }
      }

      return value;
    };

    const resultPromise: Promise<R> = runFunc();

    return new InvocationHandle(resultPromise, id, this.promiseStore);
  }

  withDefaultOpts(givenOpts: Partial<Options> = {}): Options {
    // merge tags
    const tags = { ...this.defaultInvocationOptions.tags, ...givenOpts.tags };
    return {
      ...this.defaultInvocationOptions,
      ...givenOpts,
      tags,
    };
  }

  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
  }
}

export class Context {
  #resonate: Resonate;
  childrenCount: number;
  invocationData: InvocationData;
  root: Context;
  parent: Context | undefined;

  private constructor(resonate: Resonate, invocationData: InvocationData, parent: Context | undefined) {
    this.root = !parent ? this : parent.root;
    this.parent = parent;
    this.invocationData = invocationData;
    this.childrenCount = 0;
    this.#resonate = resonate;
    if (parent) parent.childrenCount++;
  }

  static createRootContext(resonate: Resonate, invocationData: InvocationData): Context {
    return new Context(resonate, invocationData, undefined);
  }

  static createChildrenContext(parentCtx: Context, invocationData: InvocationData): Context {
    return new Context(parentCtx.#resonate, invocationData, parentCtx);
  }

  async invokeLocal<F extends Func, R>(
    func: F,
    ...argsWithOpts: [...Params<F>, PartialOptions?]
  ): Promise<InvocationHandle<R>> {
    const { args, opts: givenOpts } = utils.split(argsWithOpts);
    const { opts: registeredOpts } = this.#resonate.registeredFunction(
      this.root.invocationData.name,
      this.root.invocationData.version,
    );

    const opts = { ...registeredOpts, ...givenOpts };

    // Merge the tags
    opts.tags = { ...registeredOpts.tags, ...givenOpts.tags };

    // Default lock is false for children execution
    opts.shouldLock = opts.shouldLock ?? false;

    // If it is an anonymous function give at anon name nested with the current invocation name
    const name = func.name ? func.name : `${this.invocationData.name}__anon${this.childrenCount}`;
    const id = `${this.invocationData.id}.${this.childrenCount ?? 0}`;

    // Children execution do not need params since we don't go trough the recovery path with children
    const param = {};

    const idempotencyKey = opts.idempotencyKeyFn(id);
    const storedPromise: DurablePromiseRecord = await this.#resonate.promiseStore.create(
      id,
      idempotencyKey,
      false,
      undefined,
      opts.encoder.encode(param),
      Date.now() + opts.timeout,
      opts.tags,
    );

    const runFunc = async (): Promise<R> => {
      const eid = opts.eidFn(id);
      let value!: R;

      // If the promise that comes back from the server is already completed, resolve or reject right away.
      switch (storedPromise.state) {
        case "RESOLVED":
          return opts.encoder.decode(storedPromise.value.data) as R;
        case "REJECTED":
          throw new ResonateError(
            "Error in user function",
            ErrorCodes.USER,
            opts.encoder.decode(storedPromise.value.data),
          );
        case "REJECTED_CANCELED":
          throw new ResonateError(
            "Resonate function canceled",
            ErrorCodes.CANCELED,
            opts.encoder.decode(storedPromise.value.data),
          );
        case "REJECTED_TIMEDOUT":
          throw new ResonateError(
            `Resonate function timedout at ${new Date(storedPromise.timeout).toISOString()}`,
            ErrorCodes.TIMEDOUT,
          );
      }

      // storedPromise.state === "PENDING"
      try {
        // Acquire the lock if necessary
        if (opts.shouldLock) {
          const acquireLock = async (): Promise<boolean> => {
            try {
              return await this.#resonate.locksStore.tryAcquire(id, eid);
            } catch (e: unknown) {
              // if lock is already acquired, return false so we can poll
              if (e instanceof ResonateError && e.code === ErrorCodes.STORE_FORBIDDEN) {
                return false;
              }

              throw e;
            }
          };
          while (!(await acquireLock())) {
            await sleep(opts.pollFrequency);
          }
        }

        let error: any;
        const ctx = Context.createChildrenContext(this, { id, eid, name, version: opts.version });

        // we need to hold on to a boolean to determine if the function was successful,
        // we cannot rely on the value or error as these values could be undefined
        let success = true;
        try {
          value = await runWithRetry(() => func(ctx, ...args), opts.retryPolicy, storedPromise.timeout);
        } catch (e) {
          // We need to capture the error to be able to reject the durable promise,
          // after that we will then propagate this error by rejecting the result promise
          error = e;
          success = false;
        }

        let completedPromiseRecord!: DurablePromiseRecord;
        if (success) {
          completedPromiseRecord = await this.#resonate.promiseStore.resolve(
            id,
            idempotencyKey,
            false,
            storedPromise.value.headers,
            opts.encoder.encode(value),
          );
        } else {
          completedPromiseRecord = await this.#resonate.promiseStore.reject(
            id,
            idempotencyKey,
            false,
            storedPromise.value.headers,
            opts.encoder.encode(error),
          );
        }

        // Because of eventual consistency and recovery paths it is possible that we get a
        // rejected promise even if we did call `resolve` on it or the other way around.
        // What should never happen is that we get a "PENDING" promise
        switch (completedPromiseRecord.state) {
          case "RESOLVED":
            return value as R;
          case "REJECTED":
            throw new ResonateError("Resonate function error", ErrorCodes.USER, error);
          case "REJECTED_CANCELED":
            throw new ResonateError("Resonate function canceled", ErrorCodes.CANCELED, error);
          case "REJECTED_TIMEDOUT":
            throw new ResonateError(
              `Resonate function timedout at ${new Date(completedPromiseRecord.timeout).toISOString()}`,
              ErrorCodes.TIMEDOUT,
            );
          case "PENDING":
            throw new Error("Unreachable");
        }
      } catch (err) {
        if (err instanceof ResonateError && err.code === ErrorCodes.USER) {
          // When it is an error in the function provided by the user, unwrap the error
          throw err.cause;
        } else if (
          err instanceof ResonateError &&
          (err.code === ErrorCodes.CANCELED || err.code === ErrorCodes.TIMEDOUT)
        ) {
          // Cancel and timeout errors, just forward them
          throw err;
        } else {
          // All other errors, including resonte STORE errors and UNKNOWN errors or
          // errors that happened during fetch, for example the server was unreachable.

          // Kill the top level invocation and throw the error as is
          // kill(id)
          throw err;
        }
      } finally {
        // release lock if necessary
        if (opts.shouldLock) {
          await this.#resonate.locksStore.release(id, eid);
        }
      }

      return value;
    };

    const resultPromise: Promise<R> = runFunc();

    return new InvocationHandle(resultPromise, id, this.#resonate.promiseStore);
  }
}

export class InvocationHandle<R> {
  constructor(
    readonly resultPromise: Promise<R>,
    readonly invocationId: string,
    readonly promiseStore: IPromiseStore,
  ) {}

  async state(): Promise<"PENDING" | "RESOLVED" | "REJECTED" | "REJECTED_CANCELED" | "REJECTED_TIMEDOUT"> {
    const promiseRecord: DurablePromiseRecord = await this.promiseStore.get(this.invocationId);
    return promiseRecord.state;
  }

  async result(): Promise<R> {
    return this.resultPromise;
  }
}
