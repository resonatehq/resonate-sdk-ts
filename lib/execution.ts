import { DurablePromise } from "./core/durablePromise";
import { Options, PartialOptions, isPartialOptions } from "./core/opts";
import { IRetry } from "./core/retry";
import { Future } from "./future";

/////////////////////////////////////////////////////////////////////
// Info
/////////////////////////////////////////////////////////////////////

export class Info {
  constructor(private execution: OrdinaryExecution<any>) {}

  get id() {
    return this.execution.id;
  }

  get idempotencyKey() {
    return this.execution.idempotencyKey;
  }

  get timeout() {
    return this.execution.timeout;
  }

  get attempt() {
    return this.execution.attempt;
  }
}

/////////////////////////////////////////////////////////////////////
// Invocation
/////////////////////////////////////////////////////////////////////

export class Invocation<T> {
  constructor(
    private execution: Execution<T>,
    private func: () => T,
    private retry: IRetry = execution.opts.retry,
  ) {}

  async invoke(): Promise<T> {
    let error;

    for (const delay of this.retry.iterator(this.execution)) {
      try {
        return await this.func();
      } catch (e) {
        error = e;
        this.execution.attempt++;
      }
    }

    throw error;
  }
}

/////////////////////////////////////////////////////////////////////
// Execution
/////////////////////////////////////////////////////////////////////

export abstract class Execution<T> {
  promise: Promise<DurablePromise<T>>;
  future: Future<T>;

  createdAt: number = Date.now();

  abstract readonly kind: "ordinary" | "resonate" | "deferred";
  abstract root: ResonateExecution<any>;
  abstract parent: ResonateExecution<any> | null;
  children: Execution<any>[] = [];

  counter: number = 0;
  attempt: number = 0;

  constructor(
    public readonly id: string,
    public readonly idempotencyKey: string | undefined,
    public readonly opts: Options,
    promise: Promise<DurablePromise<T>> | DurablePromise<T>,
  ) {
    this.promise = Promise.resolve(promise);
    this.future = new Future(this);
  }

  // abstract suspendable(): boolean;
  // abstract suspend(): void | Promise<void>;

  get timeout(): number {
    return Math.min(this.createdAt + this.opts.timeout, this.parent?.timeout ?? Infinity);
  }

  get killed(): boolean {
    return this.root._killed;
  }

  setParent(execution: ResonateExecution<any>) {
    this.parent = execution;
  }

  kill(error: unknown) {
    this.root._killed = true;
    this.root._reject?.(error);
  }

  split(args: [...any, PartialOptions?]): { args: any[]; opts: Options } {
    const opts = args[args.length - 1];
    const parentOpts = this.parent?.opts ?? this.root.opts;

    return isPartialOptions(opts)
      ? { args: args.slice(0, -1), opts: { ...parentOpts, ...opts } }
      : { args, opts: parentOpts };
  }
}

export class ResonateExecution<T> extends Execution<T> {
  readonly kind = "resonate";

  root: ResonateExecution<any>;
  parent: ResonateExecution<any> | null;

  _killed: boolean = false;
  _reject?: (v: unknown) => void;

  constructor(
    id: string,
    idempotencyKey: string | undefined,
    opts: Options,
    promise: Promise<DurablePromise<T>> | DurablePromise<T>,
    parent: ResonateExecution<any> | null,
    reject?: (v: unknown) => void,
  ) {
    super(id, idempotencyKey, opts, promise);
    this.root = parent?.root ?? this;
    this.parent = parent;
    this._reject = reject;
  }

  addChild(execution: Execution<any>) {
    this.children.push(execution);
  }

  // suspendable(): boolean {
  //   // TODO: this is wrong
  //   // return this.future.completed || (!!this.blocked && this.children.every(c => c.suspendable()));
  //   // return this.blocked?.executor?.kind === "deferred" && this.children.every(c => c.suspendable());
  //   return false;
  // }

  // suspend() {}
}

export class OrdinaryExecution<T> extends Execution<T> {
  readonly kind = "ordinary";

  root: ResonateExecution<any>;
  parent: ResonateExecution<any>;

  invocation: Invocation<T>;

  constructor(
    id: string,
    idempotencyKey: string | undefined,
    opts: Options,
    promise: Promise<DurablePromise<T>> | DurablePromise<T>,
    parent: ResonateExecution<any>,
    func: (info: Info, ...args: any) => T,
    args: any[] = [],
  ) {
    super(id, idempotencyKey, opts, promise);
    this.root = parent.root;
    this.parent = parent;

    const info = new Info(this);
    this.invocation = new Invocation(this, () => func(info, ...args));
  }

  // suspendable(): boolean {
  //   return this.future.completed;
  // }

  // suspend() {}
}

export class DeferredExecution<T> extends Execution<T> {
  readonly kind = "deferred";

  root: ResonateExecution<any>;
  parent: ResonateExecution<any>;

  private interval?: number;

  constructor(
    id: string,
    idempotencyKey: string | undefined,
    opts: Options,
    promise: Promise<DurablePromise<T>> | DurablePromise<T>,
    parent: ResonateExecution<any>,
  ) {
    super(id, idempotencyKey, opts, promise);
    this.root = parent.root;
    this.parent = parent;
  }

  // suspendable(): boolean {
  //   return true;
  // }

  // suspend() {
  //   clearInterval(this.interval);
  // }

  // poll() {
  //   return this.durablePromise.complete;
  //   if (!this.interval) {
  //     this.interval = +setInterval(() => this._poll(), delay);
  //   }
  // }

  // private async _poll() {
  //   console.log("poll promise store");

  //   try {
  //     const p = await this.durablePromise;
  //     const promise = await DurablePromise.get(this.opts.store.promises, this.opts.encoder, this.id);
  //     if (!promise.pending) {
  //       this.suspend();
  //     }
  //   } catch (e) {
  //     // TODO: log
  //   }
  // }
}
