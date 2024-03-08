import { DurablePromise } from "./core/durablePromise";
import { ResonateOptions, Options, PartialOptions } from "./core/opts";
import { Retry } from "./core/retries/retry";
import * as utils from "./core/utils";
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
  scheduler: Scheduler;

  constructor(opts: Partial<ResonateOptions> = {}) {
    super(opts);
    this.scheduler = new Scheduler();
  }

  register<F extends AFunc>(
    name: string,
    func: F,
    opts: Partial<Options> = {},
  ): (id: string, ...args: Params<F>) => ResonatePromise<Return<F>> {
    return super.register(name, func, opts);
  }

  protected schedule<F extends AFunc>(
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

class AsyncExecution<T> extends ResonateExecution<T> {
  invocation: Invocation<T>;

  constructor(
    id: string,
    idempotencyKey: string | undefined,
    opts: Options,
    promise: Promise<DurablePromise<T>>,
    parent: AsyncExecution<any> | null,
    func: (...args: any[]) => T,
    args: any[],
    reject?: (v: unknown) => void,
  ) {
    super(id, idempotencyKey, opts, promise, parent, reject);

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
    const id = `${this.execution.id}.${this.execution.counter++}`;
    const idempotencyKey = utils.hash(id);
    const { args, opts } = this.execution.split(argsWithOpts);

    const promise = DurablePromise.create(opts.store.promises, opts.encoder, id, opts.timeout, { idempotencyKey });

    let execution: AsyncExecution<any> | DeferredExecution<any>;
    if (typeof func === "string") {
      execution = new DeferredExecution(func, idempotencyKey, opts, promise, this.execution);
    } else {
      execution = new AsyncExecution(id, idempotencyKey, opts, promise, this.execution, func, args);
    }

    return this.execute(execution);
  }

  io<F extends IFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Promise<Return<F>>;
  io(func: (...args: any[]) => any, ...argsWithOpts: any[]): ResonatePromise<any> {
    const id = `${this.execution.id}.${this.execution.counter++}`;
    const idempotencyKey = utils.hash(id);
    const { args, opts } = this.execution.split(argsWithOpts);

    const promise = DurablePromise.create(opts.store.promises, opts.encoder, id, opts.timeout, { idempotencyKey });

    const execution = new OrdinaryExecution(id, idempotencyKey, opts, promise, this.execution, func, args);
    return this.execute(execution);
  }

  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
  }

  private execute(
    execution: AsyncExecution<any> | OrdinaryExecution<any> | DeferredExecution<any>,
  ): ResonatePromise<any> {
    execution.promise
      .then((p) => {
        if (p.pending && execution.kind !== "deferred") {
          return execution.invocation.invoke().then(
            (v) => p.resolve(v, { idempotencyKey: execution.idempotencyKey }),
            (e) => p.reject(e, { idempotencyKey: execution.idempotencyKey }),
          );
        }

        // TODO: deferred execution
      })
      .catch((e) => execution.kill(e));

    return execution.future.promise;
  }
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

export class Scheduler {
  private executions: AsyncExecution<any>[] = [];

  add<F extends AFunc>(
    name: string,
    version: number,
    id: string,
    func: F,
    args: Params<F>,
    opts: Options,
  ): ResonatePromise<Return<F>> {
    const execution = this.executions.find((e) => e.id === id);

    if (execution && !execution.killed) {
      const { promise, resolve, reject } = ResonatePromise.deferred(id, execution.promise);
      execution.future.promise.then(resolve, reject);

      return promise;
    } else {
      const param = {
        func: name,
        args: args,
        version: version,
      };

      const headers = {
        "resonate:invocation": "true",
      };

      const idempotencyKey = utils.hash(id);

      const durablePromise = DurablePromise.create<Return<F>>(opts.store.promises, opts.encoder, id, opts.timeout, {
        idempotencyKey,
        param,
        headers,
      });

      const { promise, resolve, reject } = ResonatePromise.deferred(id, durablePromise);
      const execution = new AsyncExecution(id, idempotencyKey, opts, durablePromise, null, func, args, reject);
      execution.future.promise.then(resolve, reject);
      this.executions.push(execution);

      // TODO: handle case where promise is already completed

      durablePromise
        .then((p) =>
          execution.invocation.invoke().then(
            (v) => p.resolve(v, { idempotencyKey: execution.idempotencyKey }),
            (e) => p.reject(e, { idempotencyKey: execution.idempotencyKey }),
          ),
        )
        .catch((e) => execution.kill(e));

      return promise;
    }
  }
}
