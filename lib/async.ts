import { Execution, OrdinaryExecution, DeferredExecution } from "./core/execution";
import { ResonatePromise } from "./core/future";
import { Invocation } from "./core/invocation";
import { ResonateOptions, Options, PartialOptions } from "./core/options";
import * as utils from "./core/utils";
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

  run<F extends AFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): ResonatePromise<Return<F>>;
  run<T>(func: string, args?: any, opts?: PartialOptions): ResonatePromise<T>;
  run(func: string | ((...args: any[]) => any), ...argsWithOpts: any[]): ResonatePromise<any> {
    const id = typeof func === "string" ? func : `${this.invocation.id}.${this.invocation.counter++}`;
    const idempotencyKey = utils.hash(id);
    const { args, opts } = this.invocation.split(argsWithOpts);

    const invocation = new Invocation(id, idempotencyKey, opts, this.invocation);

    let execution: Execution<any>;
    if (typeof func === "string") {
      execution = new DeferredExecution(invocation);
    } else {
      const ctx = new Context(invocation);
      execution = new OrdinaryExecution(invocation, () => func(ctx, ...args));
    }

    return execution.execute();
  }

  io<F extends IFunc>(func: F, ...args: [...Params<F>, PartialOptions?]): Promise<Return<F>>;
  io(func: (...args: any[]) => any, ...argsWithOpts: any[]): ResonatePromise<any> {
    const id = `${this.invocation.id}.${this.invocation.counter++}`;
    const idempotencyKey = utils.hash(id);
    const { args, opts } = this.invocation.split(argsWithOpts);

    const invocation = new Invocation(id, idempotencyKey, opts, this.invocation);
    const info = new Info(invocation);
    const execution = new OrdinaryExecution(invocation, () => func(info, ...args));

    return execution.execute();
  }

  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
  }
}

/////////////////////////////////////////////////////////////////////
// Scheduler
/////////////////////////////////////////////////////////////////////

export class Scheduler {
  private executions: Record<string, { execution: Execution<any>; promise: ResonatePromise<any> }> = {};

  add<F extends AFunc>(
    name: string,
    version: number,
    id: string,
    func: F,
    args: Params<F>,
    opts: Options,
  ): ResonatePromise<Return<F>> {
    if (this.executions[id] && this.executions[id].execution.invocation.killed) {
      return this.executions[id].promise;
    }

    const idempotencyKey = utils.hash(id);
    const invocation = new Invocation<Return<F>>(id, idempotencyKey, opts);
    const ctx = new Context(invocation);
    const execution = new OrdinaryExecution(invocation, () => func(ctx, ...args));
    const promise = execution.execute();

    this.executions[id] = { execution, promise };

    return promise;
  }
}
