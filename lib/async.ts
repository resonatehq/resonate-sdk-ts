import { Future, FutureResolvers, ResonatePromise } from "./future";
import { ResonateExecution, OrdinaryExecution, Invocation, Info, Execution, DeferredExecution } from "./execution";
import { ResonateBase } from "./resonate";

import { IStore } from "./core/store";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type AsyncFunc = (ctx: Context, ...args: any[]) => unknown;

type IOFunc = (info: Info, ...args: any[]) => unknown;

type Params<F> = F extends (ctx: any, ...args: infer P) => unknown ? P : never;

type Return<F extends AsyncFunc | IOFunc> = Awaited<ReturnType<F>>;

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export class Resonate extends ResonateBase<AsyncFunc> {
  constructor(store: IStore) {
    super(store, new Scheduler(store));
  }
}

/////////////////////////////////////////////////////////////////////
// Execution
/////////////////////////////////////////////////////////////////////

class AsyncExecution<T> extends ResonateExecution<T> {
  invocation: Invocation<Context, T>;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    store: IStore,
    parent: AsyncExecution<any> | null,
    func: (...args: any[]) => T,
    args: any[],
    reject?: (v: unknown) => void,
  ) {
    super(id, future, resolvers, store, parent, reject);

    this.invocation = new Invocation(func, new Context(this), args);
  }
}

/////////////////////////////////////////////////////////////////////
// Context
/////////////////////////////////////////////////////////////////////

export class Context {
  constructor(private execution: AsyncExecution<any>) {}

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

  static run<F extends AsyncFunc>(store: IStore, id: string, func: F, args: Params<F>, reject: (v: unknown) => void) {
    const { future, resolvers } = Future.withResolvers(id);
    const execution = new AsyncExecution(id, future, resolvers, store, null, func, args, reject);

    const ctx = new Context(execution);
    ctx.durable(id, future, execution);

    return execution;
  }

  run<F extends AsyncFunc>(func: F, ...args: Params<F>): ResonatePromise<Return<F>>;
  run<T>(func: string, ...args: any): ResonatePromise<T>;
  run(func: string | ((...args: any[]) => any), ...args: any[]): Promise<any> {
    const id = typeof func === "string" ? func : `${this.execution.id}/${this.execution.counter}`;
    this.execution.counter++;

    const { future, resolvers } = Future.withResolvers(id);

    let execution: AsyncExecution<any> | DeferredExecution<any>;
    if (typeof func === "string") {
      execution = new DeferredExecution(id, future, resolvers, this.execution.store, this.execution);
    } else {
      execution = new AsyncExecution(id, future, resolvers, this.execution.store, this.execution, func, args);
    }

    return this.durable(id, future, execution);
  }

  io<F extends IOFunc>(func: F, ...args: Params<F>): Promise<Return<F>> {
    const id = `${this.execution.id}/${this.execution.counter++}`;
    const { future, resolvers } = Future.withResolvers(id);
    const execution = new OrdinaryExecution(id, future, resolvers, this.execution.store, this.execution, func, args);

    return this.durable(id, future, execution);
  }

  private durable(
    id: string,
    future: Future<any>,
    execution: AsyncExecution<any> | OrdinaryExecution<any> | DeferredExecution<any>,
  ): ResonatePromise<any> {
    const promise = execution.store.promises.create(
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

        if (future.pending && execution.kind !== "deferred") {
          execution.invocation.invoke().then(
            (value) => execution.resolve(value),
            (error) => execution.reject(error),
          );
        }
      },
      (error) => this.execution.kill(error),
    );

    return future.promise;
  }
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

export class Scheduler {
  private executions: AsyncExecution<any>[] = [];

  constructor(private store: IStore) {}

  add<F extends AsyncFunc>(id: string, func: F, args: Params<F>): ResonatePromise<Return<F>> {
    const { promise, resolve, reject } = ResonatePromise.withResolvers<Return<F>>(id);
    let execution = this.executions.find((e) => e.id === id);

    if (!execution || execution.killed) {
      execution = Context.run(this.store, id, func, args, reject);
      this.executions.push(execution);
    }

    // bind wrapper promiser to execution promise
    execution.future.promise.then(resolve, reject);
    promise.created = execution.future.promise.created;

    return promise;
  }
}
