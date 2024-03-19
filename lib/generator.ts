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

type GFunc = (ctx: Context, ...args: any[]) => Generator<Yieldable>;

type IFunc = (info: Info, ...args: any[]) => any;

type Params<F> = F extends (ctx: any, ...args: infer P) => any ? P : never;

type Return<F> = F extends (...args: any[]) => Generator<any, infer T> ? T : never;

type Yieldable = Call | Future<any>;

type Call = {
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
  scheduler: Scheduler;

  constructor(opts: Partial<ResonateOptions> = {}) {
    super(opts);
    this.scheduler = new Scheduler(this.logger);
  }

  register<F extends GFunc>(
    name: string,
    func: F,
    opts: Partial<Options> = {},
  ): (id: string, ...args: Params<F>) => ResonatePromise<Return<F>> {
    return super.register(name, func, opts);
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

  get id() {
    return this.invocation.id;
  }

  get idempotencyKey() {
    return this.invocation.idempotencyKey;
  }

  get timeout() {
    return this.invocation.timeout;
  }

  get attempt() {
    return this.invocation.attempt;
  }
}

export class Context {
  constructor(private invocation: Invocation<any>) {}

  get id() {
    return this.invocation.id;
  }

  get idempotencyKey() {
    return this.invocation.idempotencyKey;
  }

  get timeout() {
    return this.invocation.timeout;
  }

  get counter() {
    return this.invocation.counter;
  }

  // run returns a value
  run<F extends GFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;
  run<F extends IFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;
  run(func: string, args?: any, opts?: PartialOptions): Call;
  run(func: string | ((...args: any[]) => any), ...args: any[]): Call {
    return this._call(func, args, false);
  }

  // call returns a future
  call<F extends GFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;
  call<F extends IFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Call;
  call(func: string, args?: any, opts?: PartialOptions): Call;
  call(func: string | ((...args: any[]) => any), ...args: any[]): Call {
    return this._call(func, args, true);
  }

  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
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
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

class Scheduler {
  // tick is mutually exclusive
  private running: boolean = false;

  // all top level executions
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
    if (this.executions[id] && !this.executions[id].execution.invocation.killed) {
      return this.executions[id].promise;
    }

    const idempotencyKey = utils.hash(id);
    const invocation = new Invocation(id, idempotencyKey, opts);
    const generator = func(new Context(invocation), ...args);
    const execution = new GeneratorExecution(invocation, generator);
    const promise = execution.execute();

    execution.create().then((promise) => {
      if (promise && promise.pending) {
        this.runnable.push({ execution, promise, next: { kind: "init" } });
        this.tick();
      }
    });

    this.invocations.push(invocation);
    this.executions[id] = { execution, promise };

    return promise;
  }

  async tick() {
    if (this.running) return;
    this.running = true;

    while (this.runnable.length > 0) {
      const continuation = this.runnable.shift();

      if (this.logger.level === "debug" && (await this.keypress()) === "\u001b") {
        // kill when escape key is pressed
        continuation?.execution.invocation.kill("manually killed");
      }

      this.print();

      if (continuation && !continuation.execution.invocation.killed) {
        try {
          const result = this.next(continuation);

          if (result.done) {
            if (result.value instanceof Future) {
              result.value.promise.then(
                (v) => continuation.execution.resolve(continuation.promise, v),
                (e) => continuation.execution.reject(continuation.promise, e),
              );
            } else {
              await continuation.execution.resolve(continuation.promise, result.value);
            }
          } else {
            await this.apply(continuation, result.value);
          }
        } catch (error) {
          await continuation.execution.reject(continuation.promise, error);
        }

        // housekeeping
        if (continuation.execution.invocation.killed) {
          this.kill(continuation.execution);
        }
      }
    }

    // TODO: check if we can suspend

    this.running = false;
  }

  private next({ execution, next }: Continuation<any>) {
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
    const id =
      value.kind === "deferred"
        ? value.func
        : `${continuation.execution.invocation.id}.${continuation.execution.invocation.counter++}`;
    const idempotencyKey = utils.hash(id);

    const invocation = new Invocation(id, idempotencyKey, value.opts, continuation.execution.invocation);
    continuation.execution.invocation.addChild(invocation);
    this.invocations.push(invocation);

    if (value.kind === "resonate") {
      const ctx = new Context(invocation);
      const execution = new GeneratorExecution(invocation, value.func(ctx, ...value.args));
      const promise = await execution.create();

      if (promise && promise.pending) {
        this.runnable.push({ execution, promise, next: { kind: "init" } });
      }
    } else if (value.kind === "ordinary") {
      const info = new Info(invocation);
      const execution = new OrdinaryExecution(invocation, () => value.func(info, ...value.args));
      execution.execute();
    } else if (value.kind === "deferred") {
      const execution = new DeferredExecution(invocation);
      execution.execute();
    } else {
      this.yeet(`permitted call values are (resonate, ordinary, deferred), received ${value}`);
    }

    if (yieldFuture) {
      this.runnable.push({
        execution: continuation.execution,
        promise: continuation.promise,
        next: { kind: "value", value: invocation.future },
      });
    } else {
      this.applyFuture(continuation, invocation.future);
    }
  }

  private applyFuture({ execution, promise }: Continuation<any>, future: Future<any>) {
    if (execution.invocation.future.root !== future.root) {
      this.yeet(
        `yielded future originates from ${future.root.id}, but this execution originates from ${execution.invocation.future.root.id}`,
      );
    }

    execution.invocation.await(future);
    execution.invocation.block(future);
    this.awaiting.push(execution);

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

    future.promise.then(
      (value: any) => apply({ kind: "value", value }),
      (error: any) => apply({ kind: "error", error }),
    );
  }

  private kill(execution: Execution<any>) {
    const killed = this.invocations.filter((i) => i.root === execution.invocation.root);
    this.killed = this.killed.concat(killed);

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

  print() {
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

  // helper functions
  private yeet(msg: string): never {
    this.logger.error(msg);
    process.exit(1);
  }
}
