import { Future, FutureResolvers } from "./future";
import { ResonateExecution, OrdinaryExecution, Info } from "./execution";
import { resolveDurablePromise, rejectDurablePromise, syncFutureToDurablePromise } from "./helpers";

import { IStore } from "./core/store";

/////////////////////////////////////////////////////////////////////
// Context
/////////////////////////////////////////////////////////////////////

type Opts = {
  durable: boolean;
  ignore: boolean;
};

class Invocation<T> {
  constructor(
    private func: (ctx: Context, ...args: any[]) => T,
    private args: any[],
  ) {}

  async invoke(ctx: Context): Promise<T> {
    return this.func(ctx, ...this.args);
  }
}

export class Context {
  constructor(
    private store: IStore,
    private execution: AsyncExecution<any>,
  ) {}

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

  static run<A extends any[], R>(store: IStore, id: string, func: (ctx: Context, ...args: A) => R, ...args: A) {
    const { future, resolvers } = Future.withResolvers<R>(id);
    const execution = new AsyncExecution(id, future, resolvers, null, func, args);

    const ctx = new Context(store, execution);
    return ctx.onionize(id, future, execution);
  }

  async run<A extends any[], R>(func: (ctx: Context, ...args: A) => R, ...args: A): Promise<R> {
    const id = `${this.execution.id}/${this.execution.counter++}`;
    const { future, resolvers } = Future.withResolvers<R>(id);
    const execution = new AsyncExecution(id, future, resolvers, this.execution, func, args);

    return this.onionize(id, future, execution);
  }

  async io<A extends any[], R>(func: (info: Info, ...args: A) => R, ...args: A): Promise<R> {
    const id = `${this.execution.id}/${this.execution.counter++}`;
    const { future, resolvers } = Future.withResolvers<R>(id);
    const execution = new OrdinaryExecution(id, future, resolvers, this.execution, func, args);

    return this.onionize(id, future, execution);
  }

  private async onionize<T>(
    id: string,
    future: Future<T>,
    execution: AsyncExecution<T> | OrdinaryExecution<T>,
    opts: Opts = { durable: true, ignore: false },
  ): Promise<T> {
    const ctx = new Context(this.store, this.execution);

    if (!opts.durable) {
      future.promise.created = Promise.resolve(id);
      execution.invocation.invoke(ctx).then(execution.resolvers.resolve, execution.resolvers.reject);
    } else {
      try {
        const creationPromise = this.store.promises.create(
          id,
          id,
          false,
          undefined,
          undefined,
          Number.MAX_SAFE_INTEGER,
          undefined,
        );
        future.promise.created = creationPromise.then(() => id);

        const promise = await creationPromise;

        if (promise.state === "PENDING") {
          execution.invocation.invoke(ctx).then(
            (value) => resolveDurablePromise(this.store, execution, value),
            (error) => rejectDurablePromise(this.store, execution, error),
          );
        } else {
          if (!opts.ignore) {
            // future.set(promise);
            syncFutureToDurablePromise(promise, execution.resolvers);
          } else {
            // why? because
            execution.invocation.invoke(ctx).then(
              () => syncFutureToDurablePromise(promise, execution.resolvers),
              () => syncFutureToDurablePromise(promise, execution.resolvers),
            );
          }
        }
      } catch (error) {
        this.execution.kill(error);
      }
    }

    return future.promise;
  }
}

/////////////////////////////////////////////////////////////////////
// Async Execution
/////////////////////////////////////////////////////////////////////

export class AsyncExecution<T> extends ResonateExecution<T> {
  invocation: Invocation<T>;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    parent: AsyncExecution<any> | null,
    func: (ctx: Context, ...args: any) => T,
    args: any[] = [],
    reject?: (v: unknown) => void,
  ) {
    super(id, future, resolvers, parent, reject);

    // context is the first argument of the generator
    this.invocation = new Invocation(func, args);
  }
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

export class Scheduler {
  constructor(private store: IStore) {}

  async add<T>(id: string, func: (ctx: Context, ...args: any[]) => T, args: any[]): Promise<T> {
    // TODO: grab execution and return promise if it already exists
    return Context.run(this.store, id, func, ...args);
  }
}
