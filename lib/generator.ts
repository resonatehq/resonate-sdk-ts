import { DeferredExecution, Execution, GeneratorExecution, OrdinaryExecution } from "./core/execution";
import { Future, ResonatePromise } from "./core/future";
import { Invocation } from "./core/invocation";
import { ILogger } from "./core/logger";
import { ResonateOptions, Options, PartialOptions } from "./core/options";
import { DurablePromise } from "./core/promises/promises";
import * as utils from "./core/utils";
import { ResonateBase } from "./resonate";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

export type GFunc = (ctx: Context, ...args: any[]) => Generator<Yieldable>;

export type IFunc = (info: Info, ...args: any[]) => any;

export type Params<F> = F extends (ctx: any, ...args: infer P) => any ? P : never;

export type Return<F> = F extends (...args: any[]) => Generator<any, infer T> ? T : never;

export type Yieldable = Call | Future<any>;

export type Call = {
  kind: "call";
  value: ResonateFunction | OrdinaryFunction | DeferredFunction;
  yieldFuture: boolean;
};

type ResonateFunction = {
  kind: "resonate";
  func: GFunc;
  args: any[];
  opts: Options;
};

type OrdinaryFunction = {
  kind: "ordinary";
  func: IFunc;
  args: any[];
  opts: Options;
};

type DeferredFunction = {
  kind: "deferred";
  func: string;
  args: any;
  opts: Options;
};

type Continuation<T> = {
  execution: GeneratorExecution<T>;
  promise: DurablePromise<T>;
  next: Next;
};

type Next = { kind: "init" } | { kind: "value"; value: any } | { kind: "error"; error: unknown };

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
    this.scheduler = new Scheduler(this.logger);
  }

  /**
   * Register a function with Resonate. Registered functions can be invoked by calling {@link run}, or by the returned function.
   *
   * @template F The type of the generator function.
   * @param name A unique name to identify the function.
   * @param func The generator function to register with Resonate.
   * @param opts Resonate options, can be constructed by calling {@link options}.
   * @returns Resonate function
   */
  register<F extends GFunc>(
    name: string,
    func: F,
    opts?: Partial<Options>,
  ): (id: string, ...args: any) => ResonatePromise<Return<F>>;
  register<F extends GFunc>(
    name: string,
    version: number,
    func: F,
    opts?: Partial<Options>,
  ): (id: string, ...args: any) => ResonatePromise<Return<F>>;
  register<F extends GFunc>(
    name: string,
    funcOrVersion: F | number,
    funcOrOpts: F | Partial<Options>,
  ): (id: string, ...args: any) => ResonatePromise<Return<F>> {
    return super.register(name, funcOrVersion, funcOrOpts);
  }

  /**
   * Register a module with Resonate. Registered functions can be invoked by calling {@link run}.
   *
   * @template F The type of the generator function.
   * @param module The module to register with Resonate.
   * @param opts Resonate options, can be constructed by calling {@link options}.
   * @returns Resonate function
   */
  registerModule<F extends GFunc>(module: Record<string, F>, opts: Partial<Options> = {}) {
    super.registerModule(module, opts);
  }

  protected execute<F extends GFunc>(
    name: string,
    version: number,
    id: string,
    func: F,
    args: Params<F>,
    opts: Options,
  ): ResonatePromise<Return<F>> {
    return this.scheduler.add(name, version, id, func, args, opts);
  }
}

/////////////////////////////////////////////////////////////////////
// Context
/////////////////////////////////////////////////////////////////////

export class Info {
  constructor(private invocation: Invocation<any>) {}

  /**
   * The running count of function execution attempts.
   */
  get attempt() {
    return this.invocation.attempt;
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
    return this.invocation.version;
  }
}

export class Context {
  constructor(private invocation: Invocation<any>) {}

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
    return this.invocation.version;
  }

  /**
   * Invoke a generator function.
   *
   * @template F The type of the generator function.
   * @param func The function to invoke.
   * @param args The function arguments, optionally followed by {@link options}.
   * @returns A {@link Call} that can be yielded for a value.
   */
  run<F extends GFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;

  /**
   * Invoke a function.
   *
   * @template F The type of the function.
   * @param func The function to invoke.
   * @param args The function arguments, optionally followed by {@link options}.
   * @returns A {@link Call} that can be yielded for a value.
   */
  run<F extends IFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;

  /**
   * Invoke a remote function.
   *
   * @param func The id of the remote function.
   * @param args The arguments to pass to the remote function.
   * @param opts Optional {@link options}.
   * @returns A {@link Call} that can be yielded for a value.
   */
  run(func: string, args?: any, opts?: PartialOptions): Call;
  run(func: string | ((...args: any[]) => any), ...args: any[]): Call {
    return this._call(func, args, false);
  }

  /**
   * Invoke a generator function.
   *
   * @template F The type of the generator function.
   * @param func The function to invoke.
   * @param args The function arguments, optionally followed by {@link options}.
   * @returns A {@link Call} that can be yielded for a {@link Future}.
   */
  call<F extends GFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;

  /**
   * Invoke a function.
   *
   * @template F The type of the function.
   * @param func The function to invoke.
   * @param args The function arguments, optionally followed by {@link options}.
   * @returns A {@link Call} that can be yielded for a {@link Future}.
   */
  call<F extends IFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;

  /**
   * Invoke a remote function.
   *
   * @param func The id of the remote function.
   * @param args The arguments to pass to the remote function.
   * @param opts Optional {@link options}.
   * @returns A {@link Call} that can be yielded for a {@link Future}.
   */
  call(func: string, args?: any, opts?: PartialOptions): Call;
  call(func: string | ((...args: any[]) => any), ...args: any[]): Call {
    return this._call(func, args, true);
  }

  private _call(func: string | ((...args: any[]) => any), argsWithOpts: any[], yieldFuture: boolean): Call {
    const { args, opts } = this.invocation.split(argsWithOpts);

    if (typeof func === "string") {
      return { kind: "call", value: { kind: "deferred", func, args: args[0], opts }, yieldFuture };
    } else if (func.constructor.name === "GeneratorFunction") {
      return { kind: "call", value: { kind: "resonate", func, args, opts }, yieldFuture };
    } else {
      return { kind: "call", value: { kind: "ordinary", func, args, opts }, yieldFuture };
    }
  }

  /**
   * Construct options.
   *
   * @param opts A partial {@link Options} object.
   * @returns Options with the __resonate flag set.
   */
  options(opts: Partial<Options> = {}): Partial<Options> & { __resonate: true } {
    return { ...opts, __resonate: true };
  }
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

class Scheduler {
  // tick is mutually exclusive
  private running: boolean = false;

  // all top level executions and their corresponding promises
  private executions: Record<string, { execution: Execution<any>; promise: ResonatePromise<any> }> = {};

  // all invocations
  private invocations: Invocation<any>[] = [];

  // executions with a next value
  private runnable: Continuation<any>[] = [];

  // executions that are waiting for a next value
  private awaiting: Execution<any>[] = [];

  // executions that have been killed
  private killed: Invocation<any>[] = [];

  constructor(private logger: ILogger) {}

  add(name: string, version: number, id: string, func: GFunc, args: any[], opts: Options) {
    // if the execution is already running, and not killed,
    // return the promise
    if (this.executions[id] && !this.executions[id].execution.invocation.killed) {
      return this.executions[id].promise;
    }

    // the idempotency key is a hash of the id
    const idempotencyKey = utils.hash(id);

    // params, used for recovery
    const param = {
      func: name,
      version,
      args,
    };

    // add an invocation tag
    opts.tags["resonate:invocation"] = "true";

    // create a new invocation
    const invocation = new Invocation(id, idempotencyKey, param, opts, version);

    // create a new execution
    const generator = func(new Context(invocation), ...args);
    const execution = new GeneratorExecution(invocation, generator);
    const promise = execution.execute();

    // once the durable promise has been created,
    // add the execution to runnable
    execution.create().then((promise) => {
      if (promise && promise.pending) {
        this.runnable.push({ execution, promise, next: { kind: "init" } });
        this.tick();
      }
    });

    // store the invocation, execution, and promise
    // will be used if run is called again with the same id
    this.invocations.push(invocation);
    this.executions[id] = { execution, promise };

    return promise;
  }

  private async tick() {
    // need to ensure that tick is mutually exclusive,
    // if tick is already running all continuations will be picked up in the while loop
    if (this.running) return;
    this.running = true;

    while (this.runnable.length > 0) {
      // grab the next continuation
      const continuation = this.runnable.shift();

      // step through the generator if in debug mode
      if (this.logger.level === "debug" && (await this.keypress()) === "\u001b") {
        // kill when escape key is pressed
        continuation?.execution.invocation.kill("manually killed");
      }

      // print all invocations if in debug mode
      this.print();

      if (continuation && !continuation.execution.invocation.killed) {
        try {
          // apply the next value to the generator
          const result = this.next(continuation);

          // if done, we can resolve the execution
          if (result.done) {
            // need to handle the special case where a generator returns a future
            if (result.value instanceof Future) {
              result.value.promise.then(
                (v) => continuation.execution.resolve(continuation.promise, v),
                (e) => continuation.execution.reject(continuation.promise, e),
              );
            } else {
              // resolve the durable promise
              await continuation.execution.resolve(continuation.promise, result.value);
            }
          } else {
            // apply the yielded value to the generator
            await this.apply(continuation, result.value);
          }
        } catch (error) {
          // if anything goes wrong, reject the durable promise
          await continuation.execution.reject(continuation.promise, error);
        }

        // housekeeping
        if (continuation.execution.invocation.killed) {
          this.kill(continuation.execution);
        }
      }
    }

    // TODO: suspend

    // set running back to false
    this.running = false;
  }

  private next({ execution, next }: Continuation<any>) {
    // apply the next value to the generator
    switch (next.kind) {
      case "init":
        return execution.generator.next();
      case "value":
        return execution.generator.next(next.value);
      case "error":
        return execution.generator.throw(next.error);
      default:
        this.yeet(`permitted continuation values are (init, value, error), received ${next}`);
    }
  }

  private async apply(continuation: Continuation<any>, yielded: Yieldable) {
    // apply the yielded value to the generator
    switch (yielded.kind) {
      case "call":
        await this.applyCall(continuation, yielded);
        break;
      case "future":
        this.applyFuture(continuation, yielded);
        break;
      default:
        this.yeet(`permitted yielded values are (call, future), received ${yielded}`);
    }
  }

  private async applyCall(continuation: Continuation<any>, { value, yieldFuture }: Call) {
    // the id is either:
    // 1. a provided string in the case of a deferred execution
    // 2. a generated string in the case of an ordinary execution
    const id =
      value.kind === "deferred"
        ? value.func
        : `${continuation.execution.invocation.id}.${continuation.execution.invocation.counter}`;

    // the idempotency key is a hash of the id
    const idempotencyKey = utils.hash(id);

    // create a new invocation
    const invocation = new Invocation(
      id,
      idempotencyKey,
      undefined,
      value.opts,
      continuation.execution.invocation.version,
      continuation.execution.invocation,
    );
    this.invocations.push(invocation);

    // add child and increment counter
    continuation.execution.invocation.addChild(invocation);
    continuation.execution.invocation.counter++;

    if (value.kind === "resonate") {
      // create a generator execution
      const ctx = new Context(invocation);
      const execution = new GeneratorExecution(invocation, value.func(ctx, ...value.args));
      const promise = await execution.create();

      if (promise && promise.pending) {
        // if the durable promise is pending, add to runnable
        this.runnable.push({ execution, promise, next: { kind: "init" } });
      }
    } else if (value.kind === "ordinary") {
      // create an ordinary execution
      const info = new Info(invocation);
      const execution = new OrdinaryExecution(invocation, () => value.func(info, ...value.args));
      execution.execute();
    } else if (value.kind === "deferred") {
      // create a deferred execution
      const execution = new DeferredExecution(invocation);
      execution.execute();
    } else {
      this.yeet(`permitted call values are (resonate, ordinary, deferred), received ${value}`);
    }

    if (yieldFuture) {
      // if the call is expected to yield a future, add the future to runnable
      this.runnable.push({
        execution: continuation.execution,
        promise: continuation.promise,
        next: { kind: "value", value: invocation.future },
      });
    } else {
      // otherwise, skip ahead to apply future
      this.applyFuture(continuation, invocation.future);
    }
  }

  private applyFuture({ execution, promise }: Continuation<any>, future: Future<any>) {
    if (execution.invocation.future.root !== future.root) {
      this.yeet(
        `yielded future originates from ${future.root.id}, but this execution originates from ${execution.invocation.future.root.id}`,
      );
    }

    // add to awaiting
    this.awaiting.push(execution);
    execution.invocation.await(future);
    execution.invocation.block(future);

    const apply = (next: Next) => {
      // unblock
      execution.invocation.unblock();

      // remove from awaiting
      this.awaiting = this.awaiting.filter((e) => e !== execution);

      // add to runnable
      this.runnable.push({ execution, promise, next });

      // tick again
      this.tick();
    };

    // add the next value to runnable when the future fulfills
    future.promise.then(
      (value: any) => apply({ kind: "value", value }),
      (error: any) => apply({ kind: "error", error }),
    );
  }

  private kill(execution: Execution<any>) {
    // add to killed
    const killed = this.invocations.filter((i) => i.root === execution.invocation.root);
    this.killed = this.killed.concat(killed);

    // remove from awaiting and runnable
    this.awaiting = this.awaiting.filter((e) => e.invocation.root !== execution.invocation.root);
    this.runnable = this.runnable.filter((c) => c.execution.invocation.root !== execution.invocation.root);
  }

  private async keypress(): Promise<string> {
    this.logger.debug("Press any key to continue...");

    return new Promise((resolve) => {
      const onData = (data: Buffer) => {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();

        const c = data.toString();
        if (c === "\u0003") {
          this.logger.debug("^C");
          process.exit(1);
        }
        resolve(c);
      };

      process.stdin.resume();
      process.stdin.setRawMode(true);
      process.stdin.once("data", onData);
    });
  }

  private print() {
    this.logger.debug("Invocations");
    this.logger.table(
      this.invocations.map((i) => ({
        id: i.id,
        idempotencyKey: i.idempotencyKey,
        parent: i.parent ? i.parent.id : undefined,
        killed: i.killed,
        awaited: i.awaited.map((f) => f.id).join(","),
        blocked: i.blocked?.id,
      })),
    );
  }

  private yeet(msg: string): never {
    // an unrecoverable error has occurred, log and exit
    this.logger.error(msg);
    process.exit(1);
  }
}
