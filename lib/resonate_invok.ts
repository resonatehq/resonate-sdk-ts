import { JSONEncoder } from "./core/encoders/json";
import { ErrorCodes, ResonateError } from "./core/errors";
import { Logger } from "./core/loggers/logger";
import { PartialOptions, Options, InvocationOverrides, ResonateOptions, options } from "./core/options";
import * as durablePromises from "./core/promises/promises";
import { DurablePromiseRecord } from "./core/promises/types";
import * as retryPolicies from "./core/retry";
import { runWithRetry } from "./core/retry";
import * as schedules from "./core/schedules/schedules";
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
  opts: Options;
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
  #invocationHandles: Map<string, InvocationHandle<any>>;
  defaultInvocationOptions: Options;
  public readonly promises: ResonatePromises;
  public readonly schedules: ResonateSchedules;

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

    this.#invocationHandles = new Map();

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

    // promises
    this.promises = {
      create: <T>(id: string, timeout: number, opts: Partial<durablePromises.CreateOptions> = {}) =>
        durablePromises.DurablePromise.create<T>(this.promisesStore, encoder, id, timeout, opts),

      resolve: <T>(id: string, value: T, opts: Partial<durablePromises.CompleteOptions> = {}) =>
        durablePromises.DurablePromise.resolve<T>(this.promisesStore, encoder, id, value, opts),

      reject: <T>(id: string, error: any, opts: Partial<durablePromises.CompleteOptions> = {}) =>
        durablePromises.DurablePromise.reject<T>(this.promisesStore, encoder, id, error, opts),

      cancel: <T>(id: string, error: any, opts: Partial<durablePromises.CompleteOptions> = {}) =>
        durablePromises.DurablePromise.cancel<T>(this.promisesStore, encoder, id, error, opts),

      get: <T>(id: string) => durablePromises.DurablePromise.get<T>(this.promisesStore, encoder, id),

      search: (id: string, state?: string, tags?: Record<string, string>, limit?: number) =>
        durablePromises.DurablePromise.search(this.promisesStore, encoder, id, state, tags, limit),
    };

    // schedules
    this.schedules = {
      create: (
        id: string,
        cron: string,
        promiseId: string,
        promiseTimeout: number,
        opts: Partial<schedules.Options> = {},
      ) => schedules.Schedule.create(this.#store.schedules, encoder, id, cron, promiseId, promiseTimeout, opts),

      get: (id: string) => schedules.Schedule.get(this.#store.schedules, encoder, id),
      search: (id: string, tags?: Record<string, string>, limit?: number) =>
        schedules.Schedule.search(this.#store.schedules, encoder, id, tags, limit),
    };
  }

  get promisesStore() {
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

  registerModule(module: Record<string, Func>, opts: Partial<Options> = {}) {
    for (const key in module) {
      this.register(key, module[key], opts);
    }
  }

  async run<R>(name: string, id: string, ...argsWithOverrides: [...any, InvocationOverrides?]): Promise<R> {
    const handle = await this.invokeLocal<R>(name, id, ...argsWithOverrides);
    return await handle.result();
  }

  async invokeLocal<R>(
    name: string,
    id: string,
    ...argsWithOverrides: [...any, InvocationOverrides?]
  ): Promise<InvocationHandle<R>> {
    if (this.#invocationHandles.has(id)) {
      return this.#invocationHandles.get(id) as InvocationHandle<R>;
    }
    const { args, opts: optionOverrides } = utils.split(argsWithOverrides);

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
    const storedPromise: DurablePromiseRecord = await this.promisesStore.create(
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
        const ctx = Context.createRootContext(this, { id, eid, name, opts });

        // we need to hold on to a boolean to determine if the function was successful,
        // we cannot rely on the value or error as these values could be undefined
        let success = true;
        try {
          value = await runWithRetry(
            async () => {
              ctx.reset();
              return await func(ctx, ...args);
            },
            opts.retryPolicy,
            storedPromise.timeout,
          );
        } catch (e) {
          // We need to capture the error to be able to reject the durable promise
          // after that we will then propagate this error by rejecting the result promise
          error = e;
          success = false;
        }

        let completedPromiseRecord!: DurablePromiseRecord;
        if (success) {
          completedPromiseRecord = await this.promisesStore.resolve(
            id,
            idempotencyKey,
            false,
            storedPromise.value.headers,
            opts.encoder.encode(value),
          );
        } else {
          completedPromiseRecord = await this.promisesStore.reject(
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
    const handle = new InvocationHandle(resultPromise, id, this.promisesStore);
    this.#invocationHandles.set(id, handle);
    return handle;
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
}

export class Context {
  #resonate: Resonate;
  #stopAllPolling: boolean = false;
  #invocationHandles: Map<string, InvocationHandle<any>>;
  childrenCount: number;
  readonly invocationData: InvocationData;
  parent: Context | undefined;
  root: Context;

  private constructor(resonate: Resonate, invocationData: InvocationData, parent: Context | undefined) {
    this.#resonate = resonate;
    this.#invocationHandles = new Map();
    this.parent = parent;
    this.root = !parent ? this : parent.root;
    this.invocationData = invocationData;
    this.childrenCount = 0;
  }

  static createRootContext(resonate: Resonate, invocationData: InvocationData): Context {
    return new Context(resonate, invocationData, undefined);
  }

  static createChildrenContext(parentCtx: Context, invocationData: InvocationData): Context {
    return new Context(parentCtx.#resonate, invocationData, parentCtx);
  }

  reset() {
    this.childrenCount = 0;
  }

  finalize() {
    // TODO: await all the invocation handles
  }

  /**
   * Invoke a remote function.
   *
   * @template R The return type of the remote function.
   * @param func The id of the remote function.
   * @param args The arguments to pass to the remote function.
   * @param opts Optional {@link options}.
   * @returns A promise that resolves to the resolved value of the remote function.
   */
  async run<R>(funcId: string, args: any, opts?: PartialOptions): Promise<R>;

  /**
   * Invoke a function.
   *
   * @template F The type of the function.
   * @param func The function to invoke.
   * @param args The function arguments, optionally followed by {@link options}.
   * @returns A promise that resolves to the return value of the function.
   */
  async run<F extends Func>(func: F, ...argsWithOpts: [...Params<F>, PartialOptions?]): Promise<Return<F>>;

  async run<F extends Func, R>(
    funcOrId: F | string,
    ...argsWithOpts: [...Params<F>, PartialOptions?]
  ): Promise<ReturnType<F> | R> {
    let handle!: InvocationHandle<R>;
    if (typeof funcOrId === "string") {
      handle = await this.invokeRemote<R>(funcOrId, ...argsWithOpts);
    } else {
      handle = await this.invokeLocal<F, ReturnType<F>>(funcOrId, ...argsWithOpts);
    }
    return await handle.result();
  }

  async invokeRemote<R>(funcId: string, ...argsWithOpts: [...any, PartialOptions?]): Promise<InvocationHandle<R>> {
    if (this.#invocationHandles.has(funcId)) {
      return this.#invocationHandles.get(funcId) as InvocationHandle<R>;
    }

    const { opts: givenOpts } = utils.split(argsWithOpts);

    const { opts: registeredOpts } = this.#resonate.registeredFunction(
      this.root.invocationData.name,
      this.root.invocationData.opts.version,
    );

    const opts = { ...registeredOpts, ...givenOpts };

    // Merge the tags
    opts.tags = { ...registeredOpts.tags, ...givenOpts?.tags };

    // Default lock is false for children execution
    opts.shouldLock = opts.shouldLock ?? false;

    // Children execution do not need params since we don't go trough the recovery path with children
    const param = {};

    const idempotencyKey = opts.idempotencyKeyFn(funcId);
    const storedPromise: DurablePromiseRecord = await this.#resonate.promisesStore.create(
      funcId,
      idempotencyKey,
      false,
      undefined,
      opts.encoder.encode(param),
      Date.now() + opts.timeout,
      opts.tags,
    );

    const runFunc = async (): Promise<R> => {
      while (!this.#stopAllPolling) {
        const durablePromiseRecord: DurablePromiseRecord = await this.#resonate.promisesStore.get(storedPromise.id);
        switch (durablePromiseRecord.state) {
          case "RESOLVED":
            return opts.encoder.decode(durablePromiseRecord.value.data) as R;
          case "REJECTED":
            throw opts.encoder.decode(durablePromiseRecord.value.data);
          case "REJECTED_CANCELED":
            throw new ResonateError(
              "Resonate function canceled",
              ErrorCodes.CANCELED,
              opts.encoder.decode(durablePromiseRecord.value.data),
            );
          case "REJECTED_TIMEDOUT":
            throw new ResonateError(
              `Resonate function timedout at ${new Date(durablePromiseRecord.timeout).toISOString()}`,
              ErrorCodes.TIMEDOUT,
            );
          case "PENDING":
            break;
        }
        // TODO: Consider using exponential backoff instead.
        sleep(opts.pollFrequency);
      }

      throw new Error(`Polling of remote invocation with ${funcId} was stopped`);
    };
    const resultPromise: Promise<R> = runFunc();
    const invocationHandle = new InvocationHandle(resultPromise, funcId, this.#resonate.promisesStore);
    this.#invocationHandles.set(funcId, invocationHandle);

    return invocationHandle;
  }

  async invokeLocal<F extends Func, R>(
    func: F,
    ...argsWithOpts: [...Params<F>, PartialOptions?]
  ): Promise<InvocationHandle<R>> {
    const { args, opts: givenOpts } = utils.split(argsWithOpts);
    const { opts: registeredOpts } = this.#resonate.registeredFunction(
      this.root.invocationData.name,
      this.root.invocationData.opts.version,
    );

    const opts = { ...registeredOpts, ...givenOpts };

    // Merge the tags
    opts.tags = { ...registeredOpts.tags, ...givenOpts.tags };

    // Default lock is false for children execution
    opts.shouldLock = opts.shouldLock ?? false;

    this.childrenCount++;
    // If it is an anonymous function give at anon name nested with the current invocation name
    const name = func.name ? func.name : `${this.invocationData.name}__anon${this.childrenCount}`;
    const id = `${this.invocationData.id}.${this.childrenCount}.${name}`;

    if (this.#invocationHandles.has(id)) {
      return this.#invocationHandles.get(id) as InvocationHandle<R>;
    }

    if (!opts.durable) {
      // TODO: Test durability better
      const eid = opts.eidFn(id);
      const runFunc = async () => {
        const ctx = Context.createChildrenContext(this, { name, id, eid, opts });
        const timeout = Date.now() + opts.timeout;
        return (await runWithRetry(
          async () => {
            ctx.reset();
            return await func(ctx, ...args);
          },
          opts.retryPolicy,
          timeout,
        )) as R;
      };
      const resultPromise = runFunc();
      const handle = new InvocationHandle<R>(resultPromise, id, this.#resonate.promisesStore);
      this.#invocationHandles.set(id, handle);
      return handle;
    }

    // Children execution do not need params since we don't go trough the recovery path with children
    const param = {};

    const idempotencyKey = opts.idempotencyKeyFn(id);
    const storedPromise: DurablePromiseRecord = await this.#resonate.promisesStore.create(
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
        const ctx = Context.createChildrenContext(this, { id, eid, name, opts });

        // we need to hold on to a boolean to determine if the function was successful,
        // we cannot rely on the value or error as these values could be undefined
        let success = true;
        try {
          value = await runWithRetry(
            async () => {
              ctx.reset();
              return await func(ctx, ...args);
            },
            opts.retryPolicy,
            storedPromise.timeout,
          );
        } catch (e) {
          // We need to capture the error to be able to reject the durable promise,
          // after that we will then propagate this error by rejecting the result promise
          error = e;
          success = false;
        }

        let completedPromiseRecord!: DurablePromiseRecord;
        if (success) {
          completedPromiseRecord = await this.#resonate.promisesStore.resolve(
            id,
            idempotencyKey,
            false,
            storedPromise.value.headers,
            opts.encoder.encode(value),
          );
        } else {
          completedPromiseRecord = await this.#resonate.promisesStore.reject(
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
    const invocationHandle = new InvocationHandle(resultPromise, id, this.#resonate.promisesStore);
    this.#invocationHandles.set(id, invocationHandle);

    return invocationHandle;
  }

  /**
   * Durable version of sleep.
   * Sleep for the specified time (ms).
   *
   * @param ms Amount of time to sleep in milliseconds.
   * @returns A Promise that resolves after the specified time has elapsed.
   */
  async sleep(ms: number): Promise<void> {
    const id = `${this.invocationData.id}.${this.childrenCount++}`;
    const handle = await this.invokeRemote(
      id,
      options({ timeout: ms, pollFrequency: ms, tags: { "resonate:timeout": "true" }, durable: true }),
    );

    await handle.result();
  }

  /**
   * Creates a Promise that is resolved with an array of results when all of the provided Promises
   * resolve, or rejected when any Promise is rejected.
   *
   * @param values An array of Promises.
   * @param opts Optional {@link options}.
   * @returns A new ResonatePromise.
   */
  all<T extends readonly unknown[] | []>(
    values: T,
    opts: Partial<Options> = {},
  ): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
    // catch all promises to prevent unhandled promise rejections,
    // since Promise.all will not be called in the case where the
    // durable promise already completed
    for (const v of values) {
      if (v instanceof Promise) v.catch(() => {});
    }

    // prettier-ignore
    return this.run(() => Promise.all(values), options({
      retryPolicy: retryPolicies.never(),
      ...opts,
    }));
  }

  /**
   * Creates a Promise that is fulfilled by the first given promise to be fulfilled, or rejected
   * with an AggregateError.
   *
   * @param values An array of Promises.
   * @param opts Optional {@link options}.
   * @returns A new ResonatePromise.
   */
  any<T extends readonly unknown[] | []>(values: T, opts: Partial<Options> = {}): Promise<Awaited<Awaited<T[number]>>> {
    // catch all promises to prevent unhandled promise rejections,
    // since Promise.any will not be called in the case where the
    // durable promise already completed
    for (const v of values) {
      if (v instanceof Promise) v.catch(() => {});
    }

    // prettier-ignore
    return this.run(() => Promise.any(values), options({
      retryPolicy: retryPolicies.never(),
      ...opts,
    }));
  }

  /**
   * Creates a Promise that is resolved or rejected when any of the provided Promises are resolved
   * or rejected.
   *
   * @param values An array of Promises.
   * @param opts Optional {@link options}.
   * @returns A new ResonatePromise.
   */
  race<T extends readonly unknown[] | []>(values: T, opts: Partial<Options> = {}): Promise<Awaited<T[number]>> {
    // catch all promises to prevent unhandled promise rejections,
    // since Promise.race will not be called in the case where the
    // durable promise already completed
    for (const v of values) {
      if (v instanceof Promise) v.catch(() => {});
    }

    // prettier-ignore
    return this.run(() => Promise.race(values), options({
      retryPolicy: retryPolicies.never(),
      ...opts,
    }));
  }

  /**
   * Creates a Promise that is resolved with an array of results when all of the provided Promises
   * resolve or reject.
   *
   * @param values An array of Promises.
   * @param opts Optional {@link options}.
   * @returns A new Promise.
   */
  allSettled<T extends readonly unknown[] | []>(
    values: T,
    opts: Partial<Options> = {},
  ): Promise<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }> {
    // catch all promises to prevent unhandled promise rejections,
    // since Promise.allSettled will not be called in the case where the
    // durable promise already completed
    for (const v of values) {
      if (v instanceof Promise) v.catch(() => {});
    }

    // prettier-ignore
    return this.run(() => Promise.allSettled(values), options({
      retryPolicy: retryPolicies.never(),
      ...opts,
    }));
  }
}

export class InvocationHandle<R> {
  constructor(
    readonly resultPromise: Promise<R>,
    readonly invocationId: string,
    readonly promiseStore: IPromiseStore,
  ) {}

  /**
   * Retrieves the current state of the durable promise.
   *
   * @returns A Promise that resolves to the state of the durable promise.
   * The state can be one of the following:
   * - "PENDING": The promise is still in progress.
   * - "RESOLVED": The promise has been successfully fulfilled.
   * - "REJECTED": The promise has been rejected due to an error.
   * - "REJECTED_CANCELED": The promise was canceled before completion.
   * - "REJECTED_TIMEDOUT": The promise exceeded its time limit.
   *
   * @remarks
   * IMPORTANT: Users of this function should assume that it performs a direct database
   * query to fetch the current state.
   * It might not use cached data or in-memory state. Each call to this function will result
   * in a potential database read operation to ensure the most up-to-date state is returned.
   *
   * Due to the database dependency, consider the following:
   * - The function may have latency based on database performance and network conditions.
   * - Frequent calls to this function may impact database load and application performance.
   * - Ensure proper error handling for potential database connection issues.
   *
   * @example
   * while (await handle.state() === "PENDING") {
   *  console.log("promise pending");
   *  await sleep(1000);
   * }
   */
  async state(): Promise<"PENDING" | "RESOLVED" | "REJECTED" | "REJECTED_CANCELED" | "REJECTED_TIMEDOUT"> {
    // TODO: USE promiseState to return the state of the promise if it had been fulfilled already or if the promise is not durable
    const promiseRecord: DurablePromiseRecord = await this.promiseStore.get(this.invocationId);
    return promiseRecord.state;
  }

  async result(): Promise<R> {
    return this.resultPromise;
  }
}

export interface ResonatePromises {
  /**
   * Create a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param timeout Time (in milliseconds) after which the promise is considered expired.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  create<T>(
    id: string,
    timeout: number,
    opts?: Partial<durablePromises.CreateOptions>,
  ): Promise<durablePromises.DurablePromise<T>>;

  /**
   * Resolve a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param value The resolved value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  resolve<T>(
    id: string,
    value: T,
    opts?: Partial<durablePromises.CompleteOptions>,
  ): Promise<durablePromises.DurablePromise<T>>;

  /**
   * Reject a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param error The reject value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  reject<T>(
    id: string,
    error: any,
    opts?: Partial<durablePromises.CompleteOptions>,
  ): Promise<durablePromises.DurablePromise<T>>;

  /**
   * Cancel a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param error The cancel value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  cancel<T>(
    id: string,
    error: any,
    opts?: Partial<durablePromises.CompleteOptions>,
  ): Promise<durablePromises.DurablePromise<T>>;

  /**
   * Get a durable promise.
   *
   * @template T The type of the promise.
   * @param id Id of the promise.
   * @returns A durable promise.
   */
  get<T>(id: string): Promise<durablePromises.DurablePromise<T>>;

  /**
   * Search durable promises.
   *
   * @param id Ids to match, can include wildcards.
   * @param state State to match.
   * @param tags Tags to match.
   * @param limit Maximum number of durablePromises to return.
   * @returns A generator that yields durable durablePromises.
   */
  search(
    id: string,
    state?: string,
    tags?: Record<string, string>,
    limit?: number,
  ): AsyncGenerator<durablePromises.DurablePromise<any>[]>;
}

export interface ResonateSchedules {
  /**
   * Create a new schedule.
   *
   * @param id Unique identifier for the schedule.
   * @param cron CRON expression defining the schedule's execution time.
   * @param promiseId Unique identifier for the associated promise.
   * @param promiseTimeout Timeout for the associated promise in milliseconds.
   * @param opts Additional options.
   * @returns A schedule.
   */
  create(
    id: string,
    cron: string,
    promiseId: string,
    promiseTimeout: number,
    opts?: Partial<schedules.Options>,
  ): Promise<schedules.Schedule>;

  /**
   * Get a schedule.
   *
   * @param id Id of the schedule.
   * @returns A schedule.
   */
  get(id: string): Promise<schedules.Schedule>;

  /**
   * Search for schedules.
   *
   * @param id Ids to match, can include wildcards.
   * @param tags Tags to match.
   * @param limit Maximum number of schedules to return.
   * @returns A generator that yields schedules.
   */
  search(
    id: string,
    tags: Record<string, string> | undefined,
    limit?: number,
  ): AsyncGenerator<schedules.Schedule[], void>;
}
