import { Future, FutureResolvers, ResonatePromise } from "./future";
import { Execution, ResonateExecution, OrdinaryExecution, DeferredExecution, Info } from "./execution";
import { resolveDurablePromise, rejectDurablePromise, syncFutureToDurablePromise } from "./helpers";

import { IStore } from "./core/store";

/////////////////////////////////////////////////////////////////////
// Context
/////////////////////////////////////////////////////////////////////

type Yielded = Call | Future<any>;

type Call = {
  kind: "call";
  value: ResonateFunction | OrdinaryFunction | DeferredFunction;
  yieldFuture: boolean;
};

type ResonateFunction = {
  kind: "resonate";
  func: (...args: any[]) => Generator<Yielded, any>;
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
  run<A extends any[], R>(func: (ctx: Context, ...args: A) => Generator<Yielded, R>, ...args: A): Call;
  run<A extends any[], R>(func: (info: Info, ...args: A) => R, ...args: A): Call;
  run(func: string | ((...args: any[]) => any), ...args: any[]): Call {
    return this._call(func, args, false);
  }

  // call returns a future
  call(func: string, args: any): Call;
  call(func: (ctx: Context, ...args: any[]) => Generator<Yielded>, ...args: any[]): Call;
  call(func: (info: Info, ...args: any[]) => any, ...args: any[]): Call;
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
// Execution
/////////////////////////////////////////////////////////////////////

export class GeneratorExecution<T> extends ResonateExecution<T> {
  context: Context;
  generator: Generator<Yielded, T>;

  created: Future<any>[] = [];
  awaited: Future<any>[] = [];
  blocked: Future<any> | null = null;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    parent: GeneratorExecution<any> | null,
    func: (ctx: Context, ...args: any) => Generator<Yielded, T>,
    args: any[] = [],
    reject?: (v: unknown) => void,
  ) {
    super(id, future, resolvers, parent, reject);

    // construct the context
    this.context = new Context(this);

    // context is the first argument of the generator
    this.generator = func(this.context, ...args);
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
// Continuation
/////////////////////////////////////////////////////////////////////

type Continuation<T> = {
  execution: GeneratorExecution<T>;
  next: Next;
};

type Next = { kind: "init" } | { kind: "value"; value: any } | { kind: "error"; value: unknown };

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

  async add<A extends any[], R>(id: string, func: (ctx: Context, ...args: A) => Generator<Yielded, R>, args: A) {
    const { promise, resolve, reject } = ResonatePromise.withResolvers<R>(id);

    const execution = this.topLevel.find((e) => e.id === id);
    const { future, resolvers } = execution ?? Future.withResolvers<R>(id);
    future.promise.then(resolve, reject);
    // future.onComplete(resolve, reject);

    // TODO: what do we do if the execution is killed?
    if (!execution) {
      const promise = await this.store.promises.create(
        id,
        id,
        false,
        undefined,
        undefined,
        Number.MAX_SAFE_INTEGER,
        undefined,
      );
      syncFutureToDurablePromise(promise, resolvers); // TODO: rename, or put somewhere else

      if (future.pending) {
        const execution = new GeneratorExecution(id, future, resolvers, null, func, args, reject);

        this.executions.push(execution);
        this.topLevel.push(execution);
        this.runnable.push({ execution, next: { kind: "init" } });
        this.tick();
      }
    }

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
              await resolveDurablePromise(this.store, continuation.execution, result.value);
              // await continuation.execution.resolve(result.value);
            }
          } else {
            // reject the durable promise
            await this.apply(continuation.execution, result.value);
          }
        } catch (error) {
          // reject the durable promise
          await rejectDurablePromise(this.store, continuation.execution, error);
          // await continuation.execution.reject(error);
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

  private next<T>({ execution, next }: Continuation<T>) {
    switch (next.kind) {
      case "init":
        return execution.generator.next();
      case "value":
        return execution.generator.next(next.value);
      case "error":
        return execution.generator.throw(next.value);
      default:
        yeet(`permitted continuation values are (init, value, error), received ${next}`);
    }
  }

  private async apply<T>(execution: GeneratorExecution<T>, yielded: Yielded) {
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

  private async applyCall<T>(caller: GeneratorExecution<T>, { value, yieldFuture }: Call) {
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
      syncFutureToDurablePromise(promise, resolvers);
    } catch (error) {
      caller.kill(error);
      return;
    }

    let callee: Execution<any>;

    switch (value.kind) {
      case "resonate":
        const rExecution = (callee = new GeneratorExecution(id, future, resolvers, caller, value.func, value.args));

        if (future.pending) {
          this.runnable.push({ execution: rExecution, next: { kind: "init" } });
        }
        break;

      case "ordinary":
        // nullable function if future is already complete
        const func = future.pending ? value.func : () => {};

        const oExecution = (callee = new OrdinaryExecution(id, future, resolvers, caller, func, value.args));

        const apply = async (next: () => Promise<void>) => {
          // resolve/reject the durable promise
          await next();

          // tick
          this.tick();
        };

        if (future.pending) {
          oExecution.invocation.invoke().then(
            (value: any) => apply(() => resolveDurablePromise(this.store, oExecution, value)),
            (error: any) => apply(() => rejectDurablePromise(this.store, oExecution, error)),
            // (value: any) => apply(() => oExecution.resolve(value)),
            // (value: any) => apply(() => oExecution.reject(value)),
          );
        }
        break;

      case "deferred":
        const dExecution = (callee = new DeferredExecution(id, future, resolvers, caller, this.store));

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

  private applyFuture<T>(execution: GeneratorExecution<T>, future: Future<T>) {
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
      (value: any) => apply({ kind: "error", value }),
    );
  }

  // can we merge this with applyFuture?
  // we would need to wire up ordinary executions to the tick
  async delayedResolve<T>(execution: GeneratorExecution<T>, future: Future<T>) {
    execution.await(future);
    execution.block(future);
    this.awaiting.push(execution);

    const apply = async (next: () => Promise<void>) => {
      // unblock
      execution.unblock();

      // remove from awaiting
      this.awaiting = this.awaiting.filter((e) => e !== execution);

      // resolve/reject the durable promise
      await next();
    };

    future.promise.then(
      (value: any) => apply(() => resolveDurablePromise(this.store, execution, value)),
      (error: any) => apply(() => rejectDurablePromise(this.store, execution, error)),
      // (value: any) => apply(() => execution.resolve(value)),
      // (value: any) => apply(() => execution.reject(value)),
    );
  }

  private kill<T>(execution: Execution<T>) {
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
