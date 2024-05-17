import { TFC } from "./core/calls";
import { IEncoder } from "./core/encoder";
import { CallEncoder } from "./core/encoders/call";
import { JSONEncoder } from "./core/encoders/json";
import { ResonatePromise } from "./core/future";
import { Invocation } from "./core/invocation";
import { ILogger } from "./core/logger";
import { Logger } from "./core/loggers/logger";
import { ResonateOptions, Options, PartialOptions, isOptions } from "./core/options";
import * as promises from "./core/promises/promises";
import { Retry } from "./core/retries/retry";
import { IRetry } from "./core/retry";
import * as schedules from "./core/schedules/schedules";
import { IStore } from "./core/store";
import { LocalStore } from "./core/stores/local";
import { RemoteStore } from "./core/stores/remote";
import * as utils from "./core/utils";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type Func = (...args: any[]) => any;

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export abstract class ResonateBase {
  private readonly functions: Record<string, Record<number, { func: Func; opts: Options }>> = {};

  public readonly promises: ResonatePromises;
  public readonly schedules: ResonateSchedules;

  public readonly pid: string;
  public readonly poll: number;
  public readonly timeout: number;
  public readonly tags: Record<string, string>;

  public readonly encoder: IEncoder<unknown, string | undefined>;
  public readonly logger: ILogger;
  public readonly retry: IRetry;
  public readonly store: IStore;

  // TODO: get name right and make configurable
  public readonly callEncoder = new CallEncoder();

  private interval: NodeJS.Timeout | undefined;

  constructor({
    encoder = new JSONEncoder(),
    logger = new Logger(),
    pid = utils.randomId(),
    poll = 5000, // 5s
    retry = Retry.exponential(),
    store = undefined,
    tags = {},
    timeout = 10000, // 10s
    url = undefined,
  }: Partial<ResonateOptions> = {}) {
    this.encoder = encoder;
    this.logger = logger;
    this.pid = pid;
    this.poll = poll;
    this.retry = retry;
    this.tags = tags;
    this.timeout = timeout;

    if (store) {
      this.store = store;
    } else if (url) {
      this.store = new RemoteStore(url, this.pid, this.logger);
    } else {
      this.store = new LocalStore(this.logger);
    }

    // promises
    this.promises = {
      create: <T>(id: string, timeout: number, opts: Partial<promises.CreateOptions> = {}) =>
        promises.DurablePromise.create<T>(this.store.promises, this.encoder, id, timeout, opts),

      resolve: <T>(id: string, value: T, opts: Partial<promises.CompleteOptions> = {}) =>
        promises.DurablePromise.resolve<T>(this.store.promises, this.encoder, id, value, opts),

      reject: <T>(id: string, error: any, opts: Partial<promises.CompleteOptions> = {}) =>
        promises.DurablePromise.reject<T>(this.store.promises, this.encoder, id, error, opts),

      cancel: <T>(id: string, error: any, opts: Partial<promises.CompleteOptions> = {}) =>
        promises.DurablePromise.cancel<T>(this.store.promises, this.encoder, id, error, opts),

      get: <T>(id: string) => promises.DurablePromise.get<T>(this.store.promises, this.encoder, id),

      search: (id: string, state?: string, tags?: Record<string, string>, limit?: number) =>
        promises.DurablePromise.search(this.store.promises, this.encoder, id, state, tags, limit),
    };

    // schedules
    this.schedules = {
      create: (
        id: string,
        cron: string,
        promiseId: string,
        promiseTimeout: number,
        opts: Partial<schedules.Options> = {},
      ) => schedules.Schedule.create(this.store.schedules, this.encoder, id, cron, promiseId, promiseTimeout, opts),

      get: (id: string) => schedules.Schedule.get(this.store.schedules, this.encoder, id),
      search: (id: string, tags?: Record<string, string>, limit?: number) =>
        schedules.Schedule.search(this.store.schedules, this.encoder, id, tags, limit),
    };
  }

  protected abstract execute(
    func: Func,
    invocation: Invocation<any>,
    durablePromise?: promises.DurablePromise<any>,
  ): ResonatePromise<any>;

  register(name: string, func: Func, opts: Partial<Options> = {}): (id: string, ...args: any) => ResonatePromise<any> {
    // set default version
    opts.version = opts.version ?? 1;

    // set default options
    const options = this.defaults(opts);

    if (options.version <= 0) {
      throw new Error("Version must be greater than 0");
    }

    if (!this.functions[name]) {
      this.functions[name] = {};
    }

    if (this.functions[name][options.version]) {
      throw new Error(`Function ${name} version ${options.version} already registered`);
    }

    // register as latest (0) if version is greatest so far
    if (options.version > Math.max(...Object.values(this.functions[name]).map((f) => f.opts.version))) {
      this.functions[name][0] = { func, opts: options };
    }

    // register specific version
    this.functions[name][options.version] = { func, opts: options };
    return (id: string, ...args: any[]) => this.run(name, id, ...args, options);
  }

  registerModule(module: Record<string, Func>, opts: Partial<Options> = {}) {
    for (const key in module) {
      this.register(key, module[key], opts);
    }
  }

  /**
   * Run a Resonate function. Functions must first be registered with {@link register}.
   *
   * @template T The return type of the function.
   * @param id A unique id for the function invocation.
   * @param name The function name.
   * @param argsWithOpts The function arguments.
   * @returns A promise that resolve to the function return value.
   */
  run<T>(name: string, id: string, ...argsWithOpts: [...any, PartialOptions?]): ResonatePromise<T>;
  run<T>(fc: TFC): ResonatePromise<T>;
  run(nameOrFc: string | TFC, ...argsWithOpts: [...any, PartialOptions?]): ResonatePromise<any> {
    // extract id
    const id = typeof nameOrFc === "string" ? <string>argsWithOpts.shift() : nameOrFc.id;

    // extract args and opts
    const { args, opts } = this.split(argsWithOpts);

    // construct the function call
    const fc = typeof nameOrFc === "string" ? new TFC(nameOrFc, id, args, opts) : nameOrFc;

    // if version is not provided, use the latest
    const version = fc.opts.version ?? 0;

    // throw error if function is not registered
    if (!this.functions[fc.func] || !this.functions[fc.func][version]) {
      throw new Error(`Function ${fc.func} version ${version} not registered`);
    }

    // grab the registered function and default options
    const { func, opts: defaults } = this.functions[fc.func][version];

    // encode the call
    const { headers, param } = this.callEncoder.encode({ fc, version: defaults.version });

    // construct the invocation
    const invocation = new Invocation(id, fc, headers, param, defaults);

    return this.execute(func, invocation);
  }

  schedule(
    name: string,
    cron: string,
    func: Func | string,
    ...argsWithOpts: [...any, PartialOptions?]
  ): Promise<schedules.Schedule> {
    const { args, opts: partial } = this.split(argsWithOpts);

    const opts = this.defaults(partial);

    if (typeof func === "function") {
      // if function is provided, the default version is 1
      // as opposed to 0 (alias for latest version)
      opts.version = opts.version || 1;
      this.register(name, func, opts);
    }

    const funcName = typeof func === "string" ? func : name;

    if (!this.functions[funcName] || !this.functions[funcName][opts.version]) {
      throw new Error(`Function ${funcName} version ${opts.version} not registered`);
    }

    const {
      opts: { version, timeout, tags: promiseTags },
    } = this.functions[funcName][opts.version];

    const idempotencyKey =
      typeof opts.idempotencyKey === "function" ? opts.idempotencyKey(funcName) : opts.idempotencyKey;

    const fc = new TFC(funcName, "{{.id}}.{{.timestamp}}", args, opts);

    const { headers: promiseHeaders, param: promiseParam } = this.callEncoder.encode({ fc, version });

    return this.schedules.create(name, cron, "{{.id}}.{{.timestamp}}", timeout, {
      idempotencyKey,
      promiseHeaders,
      promiseParam,
      promiseTags,
    });
  }

  /**
   * Construct options.
   *
   * @param opts A partial {@link Options} object.
   * @returns PartialOptions.
   */
  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
  }

  /**
   * Start the resonate service.
   *
   * @param delay Frequency in ms to check for pending promises.
   */
  start(delay: number = 5000) {
    clearInterval(this.interval);
    this.interval = setInterval(() => this._start(), delay);
  }

  /**
   * Stop the resonate service.
   */
  stop() {
    clearInterval(this.interval);
  }

  private defaults({
    durable = true,
    eid = utils.randomId,
    encoder = this.encoder,
    idempotencyKey = utils.hash,
    lock = undefined,
    poll = this.poll,
    retry = this.retry,
    tags = {},
    timeout = this.timeout,
    version = 0,
  }: Partial<Options> = {}): Options {
    // merge tags
    tags = { ...this.tags, ...tags };

    return {
      __resonate: true,
      eid,
      durable,
      encoder,
      idempotencyKey,
      lock,
      poll,
      retry,
      tags,
      timeout,
      version,
    };
  }

  private async _start() {
    try {
      for await (const promises of this.promises.search("*", "pending", { "resonate:invocation": "true" })) {
        for (const promise of promises) {
          const headers = promise.paramHeaders;
          const param = promise.param();

          const { fc, version } = this.callEncoder.decode({
            id: promise.id,
            headers,
            param,
          });

          if (fc instanceof TFC) {
            const { func, opts } = this.functions[fc.func][version];
            const invocation = new Invocation(promise.id, fc, headers, param, opts);

            this.execute(func, invocation, promise);
          }
        }
      }
    } catch (e) {
      // squash all errors and log,
      // transient errors will be ironed out in the next interval
      this.logger.error(e);
    }
  }

  private split(args: [...any, PartialOptions?]): { args: any[]; opts: Partial<Options> } {
    const opts = args[args.length - 1];
    return isOptions(opts) ? { args: args.slice(0, -1), opts } : { args, opts: {} };
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
  create<T>(id: string, timeout: number, opts?: Partial<promises.CreateOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Resolve a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param value The resolved value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  resolve<T>(id: string, value: T, opts?: Partial<promises.CompleteOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Reject a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param error The reject value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  reject<T>(id: string, error: any, opts?: Partial<promises.CompleteOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Cancel a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param error The cancel value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  cancel<T>(id: string, error: any, opts?: Partial<promises.CompleteOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Get a durable promise.
   *
   * @template T The type of the promise.
   * @param id Id of the promise.
   * @returns A durable promise.
   */
  get<T>(id: string): Promise<promises.DurablePromise<T>>;

  /**
   * Search durable promises.
   *
   * @param id Ids to match, can include wildcards.
   * @param state State to match.
   * @param tags Tags to match.
   * @param limit Maximum number of promises to return.
   * @returns A generator that yields durable promises.
   */
  search(
    id: string,
    state?: string,
    tags?: Record<string, string>,
    limit?: number,
  ): AsyncGenerator<promises.DurablePromise<any>[]>;
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
