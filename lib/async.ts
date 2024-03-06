import { ResonateOptions, Options, PartialOptions } from "./core/opts";
import { Retry } from "./core/retries/retry";
import { IScheduler } from "./core/scheduler";
import { IStore } from "./core/store";
import { ResonateExecution, OrdinaryExecution, Invocation, Info, DeferredExecution } from "./execution";
import { ResonatePromise } from "./future";
import { ResonateBase } from "./resonate";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type AFunc = (ctx: Context, ...args: any[]) => any;

type IFunc = (info: Info, ...args: any[]) => any;

type Params<F> = F extends (ctx: any, ...args: infer P) => any ? P : never;

type Return<F> = F extends (...args: any[]) => infer T ? Awaited<T> : never;

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export class Resonate extends ResonateBase {
  constructor(opts: Partial<ResonateOptions> = {}) {
    super(Scheduler, opts);
  }

  register<F extends AFunc>(
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

class AsyncExecution<T> extends ResonateExecution<T> {
  scheduler: Scheduler;
  invocation: Invocation<T>;

  constructor(
    scheduler: Scheduler,
    id: string,
    opts: Options,
    parent: AsyncExecution<any> | null,
    func: (...args: any[]) => T,
    args: any[],
    reject?: (v: unknown) => void,
  ) {
    super(id, opts, parent, reject);

    this.scheduler = scheduler;

    const ctx = new Context(this);
    this.invocation = new Invocation(this, () => func(ctx, ...args), Retry.never());
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
    return this.execution.idempotencyKey;
  }

  get timeout() {
    return this.execution.timeout;
  }

  get counter() {
    return this.execution.counter;
  }

  run<F extends AFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): ResonatePromise<Return<F>>;
  run<T>(func: string, args?: any, opts?: PartialOptions): ResonatePromise<T>;
  run(func: string | ((...args: any[]) => any), ...argsWithOpts: any[]): ResonatePromise<any> {
    const id = this.nextId();
    const { args, opts } = this.execution.split(argsWithOpts);

    let execution: AsyncExecution<any> | DeferredExecution<any>;
    if (typeof func === "string") {
      execution = new DeferredExecution(func, opts, this.execution);
    } else {
      execution = new AsyncExecution(this.execution.scheduler, id, opts, this.execution, func, args);
    }

    return this.durable(execution);
  }

  io<F extends IFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Promise<Return<F>>;
  io(func: (...args: any[]) => any, ...argsWithOpts: any[]): ResonatePromise<any> {
    const id = this.nextId();
    const { args, opts } = this.execution.split(argsWithOpts);
    const execution = new OrdinaryExecution(id, opts, this.execution, func, args);

    return this.durable(execution);
  }

  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
  }

  private nextId() {
    return [this.execution.id, this.execution.counter++].join(this.execution.scheduler.resonate.separator);
  }

  private durable(
    execution: AsyncExecution<any> | OrdinaryExecution<any> | DeferredExecution<any>,
  ): ResonatePromise<any> {
    execution.createDurablePromise(this.execution.scheduler.store).then(
      () => {
        if (execution.future.pending) {
          if (execution.kind === "deferred") {
            execution.poll(this.execution.scheduler.store);
          } else {
            execution.invocation.invoke().then(
              (value: any) => execution.resolve(this.execution.scheduler.store, value),
              (error: any) => execution.reject(this.execution.scheduler.store, error),
            );
          }
        }
      },
      (error) => execution.kill(error),
    );

    return execution.future.promise;
  }
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

export class Scheduler implements IScheduler {
  private executions: AsyncExecution<any>[] = [];

  constructor(
    public readonly resonate: Resonate,
    public readonly store: IStore,
  ) {}

  add(name: string, version: number, id: string, func: AFunc, args: any[], opts: Options): ResonatePromise<any> {
    const { promise, resolve, reject } = ResonatePromise.deferred(id);
    let execution = this.executions.find((e) => e.id === id);

    if (!execution || execution.killed) {
      execution = new AsyncExecution(this, id, opts, null, func, args, reject);
      this.executions.push(execution);

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
            _execution.invocation.invoke().then(
              (value) => _execution.resolve(this.store, value),
              (error) => _execution.reject(this.store, error),
            );
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
}
