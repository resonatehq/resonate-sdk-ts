import { Future, FutureResolvers, ResonatePromise } from "./future";
import { Execution, ResonateExecution, OrdinaryExecution, DeferredExecution, Info } from "./execution";

import { IStore } from "./core/store";

import { ResonateBase } from "./resonate";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type GeneratorFunc = (ctx: Context, ...args: any[]) => Generator<Yieldable>;

type IOFunc = (info: Info, ...args: any[]) => any;

type Params<F> = F extends (ctx: any, ...args: infer P) => unknown ? P : never;

type Return<F> = F extends (...args: any[]) => Generator<unknown, infer T> ? T : never;

type Yieldable = Call | Future<any>;

type Call = {
  kind: "call";
  value: ResonateFunction | OrdinaryFunction | DeferredFunction;
  yieldFuture: boolean;
};

type ResonateFunction = {
  kind: "resonate";
  func: (...args: any[]) => Generator<Yieldable, any>;
  args: any[];
};

type OrdinaryFunction = {
  kind: "ordinary";
  func: (...args: any[]) => any;
  args: any[];
};

type DeferredFunction = {
  kind: "deferred";
  func: string;
  args: any;
};

type Continuation<F extends GeneratorFunc> = {
  execution: GeneratorExecution<F>;
  next: Next;
};

type Next = { kind: "init" } | { kind: "value"; value: any } | { kind: "error"; error: unknown };

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export class Resonate extends ResonateBase<GeneratorFunc> {
  constructor(store: IStore) {
    super(store, new Scheduler(store));
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
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    store: IStore,
    parent: GeneratorExecution<any> | null,
    func: (...args: any[]) => Generator<Yieldable, T>,
    args: any[],
    reject?: (v: unknown) => void,
  ) {
    super(id, future, resolvers, store, parent, reject);

    // context is the first argument of the generator
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
    return this.execution.id;
  }

  get timeout() {
    return Number.MAX_SAFE_INTEGER;
  }

  get counter() {
    return this.execution.counter;
  }

  // run returns a value
  run(func: string, args: any): Call;
  run<F extends GeneratorFunc>(func: F, ...args: Params<F>): Call;
  run<F extends IOFunc>(func: F, ...args: Params<F>): Call;
  run(func: string | ((...args: any[]) => any), ...args: any[]): Call {
    return this._call(func, args, false);
  }

  // call returns a future
  call(func: string, args: any): Call;
  call<F extends GeneratorFunc>(func: F, ...args: Params<F>): Call;
  call<F extends IOFunc>(func: F, ...args: Params<F>): Call;
  call(func: string | ((...args: any[]) => any), ...args: any[]): Call {
    return this._call(func, args, true);
  }

  private _call(func: string | ((...args: any[]) => any), args: any[], yieldFuture: boolean): Call {
    if (typeof func === "string") {
      return { kind: "call", value: { kind: "deferred", func, args: args[0] }, yieldFuture };
    } else if (func.constructor.name === "GeneratorFunction") {
      return { kind: "call", value: { kind: "resonate", func, args }, yieldFuture };
    } else {
      return { kind: "call", value: { kind: "ordinary", func, args }, yieldFuture };
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
  private executions: Execution<any>[] = [];

  // all top level executions
  private topLevel: GeneratorExecution<any>[] = [];

  // executions with a next value
  private runnable: Continuation<any>[] = [];

  // executions that are waiting for a next value
  private awaiting: GeneratorExecution<any>[] = [];

  // executions that have been killed
  private killed: Execution<any>[] = [];

  constructor(private store: IStore) {}

  add<F extends GeneratorFunc>(id: string, func: F, args: Params<F>): ResonatePromise<Return<F>> {
    const { promise, resolve, reject } = ResonatePromise.withResolvers<Return<F>>(id);
    let execution = this.topLevel.find((e) => e.id === id);

    if (!execution || execution.killed) {
      const { future, resolvers } = Future.withResolvers(id);
      execution = new GeneratorExecution(id, future, resolvers, this.store, null, func, args, reject);

      const promise = this.store.promises.create(
        id,
        id,
        false,
        undefined,
        undefined,
        Number.MAX_SAFE_INTEGER,
        undefined,
      );

      future.promise.created = promise.then(() => id);

      promise.then(
        (promise) => {
          execution.sync(promise);

          if (future.pending) {
            this.executions.push(execution);
            this.topLevel.push(execution);
            this.runnable.push({ execution, next: { kind: "init" } });
            this.tick();
          }
        },
        (error) => execution.kill(error),
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
      const key = await keypress();
      const continuation = this.runnable.shift();

      if (continuation) {
        if (key === "\u001b") {
          // esc
          continuation.execution.kill("manually killed");
        }

        try {
          const result = this.next(continuation);

          if (result.done) {
            if (result.value instanceof Future) {
              this.delayedResolve(continuation.execution, result.value);
            } else {
              // resolve the durable promise
              await continuation.execution.resolve(result.value);
            }
          } else {
            // reject the durable promise
            await this.apply(continuation.execution, result.value);
          }
        } catch (error) {
          // reject the durable promise
          await continuation.execution.reject(error);
        }

        // housekeeping
        if (continuation.execution.killed) {
          this.kill(continuation.execution);
        }
      }

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
    const id = value.kind === "deferred" ? value.func : `${caller.id}/${caller.counter}`;
    caller.counter++;

    // lazily create the future
    const { future, resolvers } = Future.withResolvers<any>(id);
    caller.create(future);

    try {
      const promise = await this.store.promises.create(
        id,
        id,
        false,
        undefined,
        undefined,
        Number.MAX_SAFE_INTEGER,
        undefined,
      );
      future.promise.created = Promise.resolve(id);
      caller.sync(promise);
    } catch (error) {
      caller.kill(error);
      return;
    }

    let callee: Execution<any>;

    switch (value.kind) {
      case "resonate":
        const rExecution = (callee = new GeneratorExecution(
          id,
          future,
          resolvers,
          this.store,
          caller,
          value.func,
          value.args,
        ));

        if (future.pending) {
          this.runnable.push({ execution: rExecution, next: { kind: "init" } });
        }
        break;

      case "ordinary":
        // nullable function if future is already complete
        const func = future.pending ? value.func : () => {};

        const oExecution = (callee = new OrdinaryExecution(
          id,
          future,
          resolvers,
          this.store,
          caller,
          func,
          value.args,
        ));

        if (future.pending) {
          oExecution.invocation.invoke().then(
            (value: any) => oExecution.resolve(value).finally(() => this.tick()),
            (error: any) => oExecution.reject(error).finally(() => this.tick()),
          );
        }
        break;

      case "deferred":
        const dExecution = (callee = new DeferredExecution(id, future, resolvers, this.store, caller));

        break;

      default:
        yeet(`permitted call values are (resonate, ordinary, deferred), received ${value}`);
    }

    caller.addChild(callee);
    callee.setParent(caller);
    this.executions.push(callee);

    if (yieldFuture) {
      this.runnable.push({ execution: caller, next: { kind: "value", value: future } });
    } else {
      this.applyFuture(caller, future);
    }
  }

  private applyFuture(execution: GeneratorExecution<any>, future: Future<any>) {
    if (execution.root !== future.executor?.root) {
      yeet(
        `yielded future originates from ${future.executor?.root.id}, but this execution originates from ${execution.root.id}`,
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
      (value: any) => execution.resolve(value).finally(cleanup),
      (error: any) => execution.reject(error).finally(cleanup),
    );
  }

  private kill(execution: Execution<any>) {
    console.log("Oh no! Killed!", execution.id);

    const killed = this.executions.filter((e) => e.root === execution.root);
    this.killed = this.killed.concat(killed);

    this.executions = this.executions.filter((e) => e.root !== execution.root);
    this.topLevel = this.topLevel.filter((e) => e.root !== execution.root);
    this.awaiting = this.awaiting.filter((e) => e.root !== execution.root);
    this.runnable = this.runnable.filter((c) => c.execution.root !== execution.root);
  }

  print() {
    // continuations table
    console.log("\n \x1b[1mContinuations\x1b[0m");
    console.table(
      this.runnable.map(({ execution, next }) => {
        return {
          id: execution.id,
          next: next,
        };
      }),
    );

    // executions table
    console.log("\n \x1b[1mExecutions\x1b[0m");
    console.table(
      this.executions.map((e) => {
        const created = e instanceof GeneratorExecution ? e.created.map((f) => f.id).join(",") : undefined;
        const awaited = e instanceof GeneratorExecution ? e.awaited.map((f) => f.id).join(",") : undefined;

        return {
          id: e.id,
          kind: e.kind,
          parent: e.parent ? e.parent.id : undefined,
          counter: e instanceof GeneratorExecution ? e.counter : undefined,
          // attempt: e.kind === "ordinary" ? e.attempt : undefined,
          state: e.future.state,
          value: e.future.value,
          killed: e.killed,
          created: created,
          awaited: awaited,
          blocked: e instanceof GeneratorExecution ? e.blocked?.id : undefined,
        };
      }),
    );

    // awaiting table
    console.log("\n \x1b[1mAwaiting\x1b[0m");
    console.table(
      this.awaiting.map((e) => {
        return {
          id: e.id,
          kind: e.kind,
          state: e.future.state,
          value: e.future.value,
          blocked: e.blocked?.id,
        };
      }),
    );

    // top level table
    console.log("\n \x1b[1mTop Level\x1b[0m");
    console.table(
      this.topLevel.map((e) => {
        return {
          id: e.id,
          kind: e.kind,
          state: e.future.state,
          value: e.future.value,
          blocked: e.blocked?.id,
        };
      }),
    );

    // killed table
    console.log("\n \x1b[1mKilled\x1b[0m");
    console.table(
      this.killed.map((e) => {
        return {
          id: e.id,
          kind: e.kind,
          parent: e.parent ? e.parent.id : undefined,
          state: e.future.state,
          value: e.future.value,
        };
      }),
    );

    console.log();
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
