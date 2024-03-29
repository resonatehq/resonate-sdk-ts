import { Execution, OrdinaryExecution, DeferredExecution } from "./core/execution";
import { ResonatePromise } from "./core/future";
import { Invocation } from "./core/invocation";
import { ResonateOptions, Options, PartialOptions } from "./core/options";
import * as schedules from "./core/schedules/schedules";
import * as utils from "./core/utils";
import { ResonateBase } from "./resonate";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

export type Func = (ctx: Context, ...args: any[]) => any;

export type Params<F> = F extends (ctx: any, ...args: infer P) => any ? P : never;

export type Return<F> = F extends (...args: any[]) => infer T ? Awaited<T> : never;

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export class Resonate extends ResonateBase {
  private scheduler: Scheduler;

  /**
   * Creates a Resonate instance. This is the starting point for using Resonate.
   *
   * @constructor
   * @param opts - A partial {@link ResonateOptions} object.
   */
  constructor(opts: Partial<ResonateOptions> = {}) {
    super(opts);
    this.scheduler = new Scheduler();
  }

  /**
   * Register a function with Resonate. Registered functions can be invoked by calling {@link run}, or by the returned function.
   *
   * @template F The type of the function.
   * @param name A unique name to identify the function.
   * @param func The function to register with Resonate.
   * @param opts Resonate options, can be constructed by calling {@link options}.
   * @returns Resonate function
   */
  register<F extends Func>(
    name: string,
    func: F,
    opts?: Partial<Options>,
  ): (id: string, ...args: Params<F>) => ResonatePromise<Return<F>> {
    return super.register(name, func, opts);
  }

  /**
   * Register a module with Resonate. Registered functions can be invoked by calling {@link run}.
   *
   * @template F The type of the function.
   * @param module The module to register with Resonate.
   * @param opts Resonate options, can be constructed by calling {@link options}.
   * @returns Resonate function
   */
  registerModule<F extends Func>(module: Record<string, F>, opts: Partial<Options> = {}) {
    super.registerModule(module, opts);
  }

  /**
   * Schedule a resonate function.
   *
   * @param name The schedule name.
   * @param cron The schedule cron expression.
   * @param func The function to schedule.
   * @param args The function arguments.
   * @returns The schedule object.
   */
  schedule<F extends Func>(
    name: string,
    cron: string,
    func: F,
    ...args: [...Params<F>, PartialOptions?]
  ): Promise<schedules.Schedule>;

  /**
   * Schedule a resonate function that is already registered.
   *
   * @param name The schedule name.
   * @param cron The schedule cron expression.
   * @param func The registered function name.
   * @param args The function arguments.
   * @returns The schedule object.
   */
  schedule(name: string, cron: string, func: string, ...args: [...any, PartialOptions?]): Promise<schedules.Schedule>;
  schedule(name: string, cron: string, func: Func | string, ...args: any[]): Promise<schedules.Schedule> {
    return super.schedule(name, cron, func, ...args);
  }

  protected execute<F extends Func>(
    name: string,
    id: string,
    idempotencyKey: string | undefined,
    func: F,
    args: Params<F>,
    opts: Options,
  ): ResonatePromise<Return<F>> {
    return this.scheduler.add(name, id, idempotencyKey, func, args, opts);
  }
}

/////////////////////////////////////////////////////////////////////
// Context
/////////////////////////////////////////////////////////////////////

export class Context {
  constructor(private invocation: Invocation<any>) {}

  /**
   * The running count of function execution attempts.
   */
  get attempt() {
    return this.invocation.attempt;
  }

  /**
   * The running count of child function invocations.
   */
  get counter() {
    return this.invocation.counter;
  }

  /**
   * Uniquely identifies the function invocation.
   */
  get id() {
    return this.invocation.id;
  }

  /**
   * Deduplicates function invocations with the same id.
   */
  get idempotencyKey() {
    return this.invocation.idempotencyKey;
  }

  /**
   * The timestamp in ms, once this time elapses the function invocation will timeout.
   */
  get timeout() {
    return this.invocation.timeout;
  }

  /**
   * The resonate function version.
   */
  get version() {
    return this.invocation.root.opts.version;
  }

  /**
   * Invoke a function.
   *
   * @template F The type of the function.
   * @param func The function to invoke.
   * @param args The function arguments, optionally followed by {@link options}.
   * @returns A promise that resolves to the return value of the function.
   */
  run<F extends Func>(func: F, ...args: [...Params<F>, PartialOptions?]): ResonatePromise<Return<F>>;

  /**
   * Invoke a remote function.
   *
   * @template T The return type of the remote function.
   * @param func The id of the remote function.
   * @param args The arguments to pass to the remote function.
   * @param opts Optional {@link options}.
   * @returns A promise that resolves to the resolved value of the remote function.
   */
  run<T>(func: string, args: any, opts?: PartialOptions): ResonatePromise<T>;

  /**
   * Invoke a remote function.
   *
   * @template T The return type of the remote function.
   * @param func The id of the remote function.
   * @param opts Optional {@link options}.
   * @returns A promise that resolves to the resolved value of the remote function.
   */
  run<T>(func: string, opts?: PartialOptions): ResonatePromise<T>;
  run(func: string | ((...args: any[]) => any), ...argsWithOpts: any[]): ResonatePromise<any> {
    // the parent is the current invocation
    const parent = this.invocation;

    // the id is either:
    // 1. a provided string in the case of a deferred execution
    // 2. a generated string in the case of an ordinary execution
    const id = typeof func === "string" ? func : `${parent.id}.${parent.counter}`;

    // human readable name of the function
    const name = typeof func === "string" ? func : func.name;

    // the idempotency key is a hash of the id
    const idempotencyKey = utils.hash(id);

    // opts are optional and can be provided as the last arg
    const { args, opts } = this.invocation.split(argsWithOpts);

    // param is only required for deferred executions
    const param = typeof func === "string" ? args[0] : undefined;

    // create a new invocation
    const invocation = new Invocation(name, id, idempotencyKey, undefined, param, opts, parent);

    let execution: Execution<any>;
    if (typeof func === "string") {
      // create a deferred execution
      // this execution will be fulfilled out-of-process
      execution = new DeferredExecution(invocation);
    } else {
      // create an ordinary execution
      // this execution wraps a user-provided function
      const ctx = new Context(invocation);
      execution = new OrdinaryExecution(invocation, () => func(ctx, ...args));
    }

    // bump the counter
    parent.counter++;

    // return a resonate promise
    return execution.execute();
  }

  /**
   * Construct options.
   *
   * @param opts A partial {@link Options} object.
   * @returns Options with the __resonate flag set.
   */
  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
  }
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

class Scheduler {
  private cache: Record<string, Execution<any>> = {};

  add<F extends Func>(
    name: string,
    id: string,
    idempotencyKey: string | undefined,
    func: F,
    args: Params<F>,
    opts: Options,
  ): ResonatePromise<Return<F>> {
    // if the execution is already running, and not killed,
    // return the promise
    if (this.cache[id] && !this.cache[id].killed) {
      // execute is idempotent
      return this.cache[id].execute();
    }

    // params, used for recovery
    const param = {
      func: name,
      version: opts.version,
      args,
    };

    // create a new invocation
    const invocation = new Invocation<Return<F>>(name, id, idempotencyKey, undefined, param, opts);

    // create a new execution
    const ctx = new Context(invocation);
    const execution = new OrdinaryExecution(invocation, () => func(ctx, ...args));

    // store the execution,
    // will be used if run is called again with the same id
    this.cache[id] = execution;

    return execution.execute();
  }
}
