import { DurablePromise } from "./core/durablePromise";
import { ResonateOptions, Options, PartialOptions } from "./core/opts";
import * as utils from "./core/utils";
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
  scheduler: Scheduler;

  constructor(opts: Partial<ResonateOptions> = {}) {
    super(opts);
    this.scheduler = new Scheduler();
  }

  register<F extends GFunc>(
    name: string,
    func: F,
    opts: Partial<Options> = {},
  ): (id: string, ...args: Params<F>) => ResonatePromise<Return<F>> {
    return super.register(name, func, opts);
  }

  protected schedule<F extends GFunc>(
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
// Execution
/////////////////////////////////////////////////////////////////////

class GeneratorExecution<T> extends ResonateExecution<T> {
  generator: Generator<Yieldable, T>;

  created: Future<any>[] = [];
  awaited: Future<any>[] = [];
  blocked: Future<any> | null = null;

  constructor(
    id: string,
    idempotencyKey: string | undefined,
    opts: Options,
    promise: Promise<DurablePromise<T>> | DurablePromise<T>,
    parent: GeneratorExecution<any> | null,
    func: (...args: any[]) => Generator<Yieldable, T>,
    args: any[],
    reject?: (v: unknown) => void,
  ) {
    super(id, idempotencyKey, opts, promise, parent, reject);

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

export class Scheduler {
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

  constructor() {}

  add(name: string, version: number, id: string, func: GFunc, args: any[], opts: Options): ResonatePromise<any> {
    const execution = this.executions.find((e) => e.id === id);

    if (execution && !execution.killed) {
      const { promise, resolve, reject } = ResonatePromise.deferred(id, execution.promise);
      execution.future.promise.then(resolve, reject);

      return promise;
    } else {
      const idempotencyKey = utils.hash(id);

      const param = {
        func: name,
        args: args,
        version: version,
      };

      const headers = {
        "resonate:invocation": "true",
      };

      const durablePromise = DurablePromise.create(opts.store.promises, opts.encoder, id, opts.timeout, {
        idempotencyKey,
        param,
        headers,
      });

      const { promise, resolve, reject } = ResonatePromise.deferred(id, durablePromise);
      const execution = new GeneratorExecution(id, idempotencyKey, opts, durablePromise, null, func, args, reject);
      execution.future.promise.then(resolve, reject);
      this.executions.push(execution);
      this.allExecutions.push(execution);

      // TODO: handle case where promise is already completed

      durablePromise
        .then((p) => this.runnable.push({ execution, next: { kind: "init" } }))
        .then(() => this.tick())
        .catch((e) => execution.kill(e));

      return promise;
    }
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
              await continuation.execution.promise
                .then((p) => p.resolve(result.value, { idempotencyKey: continuation.execution.idempotencyKey }))
                .catch((e) => continuation.execution.kill(e));
            }
          } else {
            await this.apply(continuation.execution, result.value);
          }
        } catch (error) {
          // reject the durable promise
          await continuation.execution.promise
            .then((p) => p.reject(error, { idempotencyKey: continuation.execution.idempotencyKey }))
            .catch((e) => continuation.execution.kill(e));
        }
      }

      // housekeeping
      if (continuation && continuation.execution.killed) {
        this.kill(continuation.execution);
      }

      // debugging
      this.print();
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
    const id = `${caller.id}.${caller.counter++}`;

    try {
      const idempotencyKey = utils.hash(id);

      const promise = await DurablePromise.create(
        value.opts.store.promises,
        value.opts.encoder,
        id,
        value.opts.timeout,
        { idempotencyKey },
      );

      let callee: GeneratorExecution<any> | OrdinaryExecution<any> | DeferredExecution<any>;

      switch (value.kind) {
        case "resonate":
          callee = new GeneratorExecution(id, idempotencyKey, value.opts, promise, caller, value.func, value.args);

          if (promise.pending) {
            this.runnable.push({ execution: callee, next: { kind: "init" } });
          }
          break;

        case "ordinary":
          callee = new OrdinaryExecution(id, idempotencyKey, value.opts, promise, caller, value.func, value.args);

          if (promise.pending) {
            callee.invocation
              .invoke()
              .then(
                (v) => promise.resolve(v, { idempotencyKey }),
                (e) => promise.reject(e, { idempotencyKey }),
              )
              .catch((e) => callee.kill(e))
              .finally(() => this.tick());
          }
          break;

        case "deferred":
          callee = new DeferredExecution(value.func, idempotencyKey, value.opts, promise, caller);
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

    // TODO: verify this

    future.promise
      .then(
        (v) => execution.promise.then((p) => p.resolve(v, { idempotencyKey: execution.idempotencyKey })),
        (e) => execution.promise.then((p) => p.reject(e, { idempotencyKey: execution.idempotencyKey })),
      )
      .catch((e) => execution.kill(e))
      .finally(() => cleanup());
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
          // completed: e.future.completed,
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
