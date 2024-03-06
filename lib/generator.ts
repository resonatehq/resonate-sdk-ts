import { ResonateOptions, Options, PartialOptions } from "./core/opts";
import { IScheduler } from "./core/scheduler";
import { IStore } from "./core/store";
import { Execution, ResonateExecution, OrdinaryExecution, DeferredExecution, Info } from "./execution";
import { Future, ResonatePromise } from "./future";
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
  next: Next;
};

type Next = { kind: "init" } | { kind: "value"; value: any } | { kind: "error"; error: unknown };

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export class Resonate extends ResonateBase {
  constructor(opts: Partial<ResonateOptions> = {}) {
    super(Scheduler, opts);
  }

  register<F extends GFunc>(
    name: string,
    func: F,
    opts: Partial<Options> = {},
  ): (id: string, ...args: Params<F>) => ResonatePromise<Return<F>> {
    return super.register(name, func, opts);
  }
}

/////////////////////////////////////////////////////////////////////
// Execution
/////////////////////////////////////////////////////////////////////

class GeneratorExecution<T> extends ResonateExecution<T> {
  generator: Generator<Yieldable, T>;

  created: Future<any>[] = [];
  awaited: Future<any>[] = [];
  blocked: Future<any> | null = null;

  constructor(
    id: string,
    opts: Options,
    parent: GeneratorExecution<any> | null,
    func: (...args: any[]) => Generator<Yieldable, T>,
    args: any[],
    reject?: (v: unknown) => void,
  ) {
    super(id, opts, parent, reject);

    this.generator = func(new Context(this), ...args);
  }

  create(future: Future<any>) {
    this.created.push(future);
  }

  await(future: Future<any>) {
    this.awaited.push(future);
  }

  block(future: Future<any>) {
    this.blocked = future;
  }

  unblock() {
    this.blocked = null;
  }
}

/////////////////////////////////////////////////////////////////////
// Context
/////////////////////////////////////////////////////////////////////

export class Context {
  constructor(private execution: GeneratorExecution<any>) {}

  get id() {
    return this.execution.id;
  }

  get idempotencyKey() {
    return this.execution.idempotencyKey;
  }

  get timeout() {
    return this.execution.timeout;
  }

  get counter() {
    return this.execution.counter;
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
    const { args, opts } = this.execution.split(argsWithOpts);

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

export class Scheduler implements IScheduler {
  // tick is mutually exclusive
  private running: boolean = false;

  // all executions
  private allExecutions: Execution<any>[] = [];

  // all top level executions
  private executions: GeneratorExecution<any>[] = [];

  // executions with a next value
  private runnable: Continuation<any>[] = [];

  // executions that are waiting for a next value
  private awaiting: GeneratorExecution<any>[] = [];

  // executions that have been killed
  private killed: Execution<any>[] = [];

  constructor(
    public resonate: Resonate,
    public store: IStore,
  ) {}

  add(name: string, version: number, id: string, func: GFunc, args: any[], opts: Options): ResonatePromise<any> {
    const { promise, resolve, reject } = ResonatePromise.deferred(id);
    let execution = this.executions.find((e) => e.id === id);

    if (!execution || execution.killed) {
      execution = new GeneratorExecution(id, opts, null, func, args, reject);
      this.executions.push(execution);
      this.allExecutions.push(execution);

      const data = {
        func: name,
        args: args,
        version: version,
      };

      const promise = execution.createDurablePromise(this.store, data, {
        "resonate:invocation": "true",
      });

      // why?
      const _execution = execution;

      promise.then(
        () => {
          if (_execution.future.pending) {
            this.runnable.push({ execution: _execution, next: { kind: "init" } });
            this.tick();
          }
        },
        (error) => _execution.kill(error),
      );
    }

    // bind wrapper promiser to execution promise
    execution.future.promise.then(resolve, reject);
    promise.created = execution.future.promise.created;

    return promise;
  }

  async tick() {
    if (this.running) return;
    this.running = true;

    while (this.runnable.length > 0) {
      const continuation = this.runnable.shift();

      const key = await keypress();
      if (key === "\u001b") {
        // kill when escape key is pressed
        continuation?.execution.kill("manually killed");
      }

      if (continuation && !continuation.execution.killed) {
        try {
          const result = this.next(continuation);

          if (result.done) {
            if (result.value instanceof Future) {
              this.delayedResolve(continuation.execution, result.value);
            } else {
              // resolve the durable promise
              await continuation.execution.resolve(this.store, result.value);
            }
          } else {
            // reject the durable promise
            await this.apply(continuation.execution, result.value);
          }
        } catch (error) {
          // reject the durable promise
          await continuation.execution.reject(this.store, error);
        }
      }

      // housekeeping
      if (continuation && continuation.execution.killed) {
        this.kill(continuation.execution);
      }

      // debugging
      this.print();
    }

    // check if we can suspend

    // if (this.executions.every(e => e.suspendable())) {
    //     console.log("lets suspend");
    //     // TODO: "close" the scheduler and reject anything added
    //     await Promise.all(this.executions.map(e => e.suspend()));
    // } else {
    //     console.log("cannot suspend");
    // }

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
        yeet(`permitted continuation values are (init, value, error), received ${next}`);
    }
  }

  private async apply(execution: GeneratorExecution<any>, yielded: Yieldable) {
    switch (yielded.kind) {
      case "call":
        await this.applyCall(execution, yielded);
        break;
      case "future":
        this.applyFuture(execution, yielded);
        break;
      default:
        yeet(`permitted yielded values are (call, future), received ${yielded}`);
    }
  }

  private async applyCall(caller: GeneratorExecution<any>, { value, yieldFuture }: Call) {
    const id = [caller.id, caller.counter++].join(this.resonate.separator);

    try {
      let callee: GeneratorExecution<any> | OrdinaryExecution<any> | DeferredExecution<any>;

      switch (value.kind) {
        case "resonate":
          callee = new GeneratorExecution(id, value.opts, caller, value.func, value.args);
          await callee.createDurablePromise(this.store);

          if (callee.future.pending) {
            this.runnable.push({ execution: callee, next: { kind: "init" } });
          }
          break;

        case "ordinary":
          callee = new OrdinaryExecution(id, value.opts, caller, value.func, value.args);
          await callee.createDurablePromise(this.store);

          if (callee.future.pending) {
            callee.invocation.invoke().then(
              (value: any) => callee.resolve(this.store, value).then(() => this.tick()),
              (error: any) => callee.reject(this.store, error).then(() => this.tick()),
            );
          }
          break;

        case "deferred":
          callee = new DeferredExecution(value.func, value.opts, caller);
          await callee.createDurablePromise(this.store);

          if (callee.future.pending) {
            callee.poll(this.store);
          }
          break;

        default:
          yeet(`permitted call values are (resonate, ordinary, deferred), received ${value}`);
      }

      // add to all executions
      this.allExecutions.push(callee);

      // TODO: should these move up?
      caller.addChild(callee);
      callee.setParent(caller);
      caller.create(callee.future);

      if (yieldFuture) {
        this.runnable.push({ execution: caller, next: { kind: "value", value: callee.future } });
      } else {
        this.applyFuture(caller, callee.future);
      }
    } catch (error) {
      caller.kill(error);
    }
  }

  private applyFuture(execution: GeneratorExecution<any>, future: Future<any>) {
    if (execution.future.root !== future.root) {
      yeet(
        `yielded future originates from ${future.root.id}, but this execution originates from ${execution.future.root.id}`,
      );
    }

    execution.await(future);
    execution.block(future);
    this.awaiting.push(execution);

    const apply = (next: Next) => {
      // unblock
      execution.unblock();

      // remove from awaiting
      this.awaiting = this.awaiting.filter((e) => e !== execution);

      // add to runnable
      this.runnable.push({ execution, next });

      // tick again
      this.tick();
    };

    future.promise.then(
      (value: any) => apply({ kind: "value", value }),
      (error: any) => apply({ kind: "error", error }),
    );
  }

  // can we merge this with applyFuture?
  // we would need to wire up ordinary executions to the tick
  async delayedResolve(execution: GeneratorExecution<any>, future: Future<any>) {
    if (execution.future.root !== future.root) {
      yeet(
        `yielded future originates from ${future.root.id}, but this execution originates from ${execution.future.root.id}`,
      );
    }

    execution.await(future);
    execution.block(future);
    this.awaiting.push(execution);

    const cleanup = () => {
      // unblock
      execution.unblock();

      // remove from awaiting
      this.awaiting = this.awaiting.filter((e) => e !== execution);
    };

    future.promise.then(
      (value: any) => execution.resolve(this.store, value).then(cleanup),
      (error: any) => execution.reject(this.store, error).then(cleanup),
    );
  }

  private kill(execution: Execution<any>) {
    console.log("Oh no! Killed!", execution.id);

    const killed = this.executions.filter((e) => e.root === execution.root);
    this.killed = this.killed.concat(killed);

    this.executions = this.executions.filter((e) => e.root !== execution.root);
    this.awaiting = this.awaiting.filter((e) => e.root !== execution.root);
    this.runnable = this.runnable.filter((c) => c.execution.root !== execution.root);
  }

  print() {
    // all executions
    console.log("\n \x1b[1mExecutions\x1b[0m");
    console.table(
      this.allExecutions.map((e) => {
        const created = e instanceof GeneratorExecution ? e.created.map((f) => f.id).join(",") : undefined;
        const awaited = e instanceof GeneratorExecution ? e.awaited.map((f) => f.id).join(",") : undefined;
        const blocked = e instanceof GeneratorExecution ? e.blocked?.id : undefined;

        return {
          id: e.id,
          idempotencyKey: e.idempotencyKey,
          kind: e.kind,
          parent: e.parent ? e.parent.id : undefined,
          completed: e.future.completed,
          killed: e.killed,
          created: created,
          awaited: awaited,
          blocked: blocked,
        };
      }),
    );
  }
}

// helper functions
function yeet(msg: string): never {
  console.log(msg);
  process.exit(1);
}

async function keypress(): Promise<string> {
  console.log("Press any key to continue...");

  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();

      const c = data.toString();
      if (c === "\u0003") {
        console.log("^C");
        process.exit(1);
      }
      resolve(c);
    };

    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.once("data", onData);
  });
}
