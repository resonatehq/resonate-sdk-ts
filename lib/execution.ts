import { Options, PartialOptions, isPartialOptions } from "./core/opts";
import { DurablePromise } from "./core/promise";
import { IRetry } from "./core/retry";
import { IStore } from "./core/store";

import * as utils from "./core/utils";
import { Future, FutureResolvers } from "./future";

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
  createdAt: number = Date.now();
  future: Future<T>;
  resolvers: FutureResolvers<T>;
  idempotencyKey: string;

  abstract readonly kind: "ordinary" | "resonate" | "deferred";
  abstract root: ResonateExecution<any>;
  abstract parent: ResonateExecution<any> | null;
  children: Execution<any>[] = [];

  counter: number = 0;
  attempt: number = 0;

  constructor(
    public readonly id: string,
    public readonly opts: Options,
  ) {
    const { future, resolvers } = Future.deferred<T>(this);
    this.future = future;
    this.resolvers = resolvers;
    this.idempotencyKey = utils.hash(this.id);
  }

  abstract suspendable(): boolean;
  abstract suspend(): void | Promise<void>;

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

  async createDurablePromise(store: IStore, data?: any, tags?: Record<string, string>) {
    const promise = store.promises.create(
      this.id,
      this.idempotencyKey,
      false,
      undefined,
      this.opts.encoder.encode(data),
      this.timeout,
      tags,
    );

    // bind future resonate promise to durable promise
    this.future.promise.created = promise.then(() => this.id);
    this.sync(await promise);
  }

  async resolve(store: IStore, data: any) {
    try {
      const promise = await store.promises.resolve(
        this.id,
        this.idempotencyKey,
        false,
        undefined,
        this.opts.encoder.encode(data),
      );
      this.sync(promise);
    } catch (error) {
      this.kill(error);
    }
  }

  async reject(store: IStore, data: any) {
    try {
      const promise = await store.promises.reject(
        this.id,
        this.idempotencyKey,
        false,
        undefined,
        this.opts.encoder.encode(data),
      );
      this.sync(promise);
    } catch (error) {
      this.kill(error);
    }
  }

  sync(promise: DurablePromise) {
    switch (promise.state) {
      case "RESOLVED":
        this.resolvers.resolve(this.opts.encoder.decode(promise.value.data) as T);
        break;
      case "REJECTED":
        this.resolvers.reject(this.opts.encoder.decode(promise.value.data));
        break;
      case "REJECTED_CANCELED":
        this.resolvers.cancel("canceled");
        break;
      case "REJECTED_TIMEDOUT":
        this.resolvers.timeout("timedout");
        break;
    }
  }
}

export class ResonateExecution<T> extends Execution<T> {
  readonly kind = "resonate";

  root: ResonateExecution<any>;
  parent: ResonateExecution<any> | null;

  _killed: boolean = false;
  _reject?: (v: unknown) => void;

  constructor(id: string, opts: Options, parent: ResonateExecution<any> | null, reject?: (v: unknown) => void) {
    super(id, opts);
    this.root = parent?.root ?? this;
    this.parent = parent;
    this._reject = reject;
  }

  addChild(execution: Execution<any>) {
    this.children.push(execution);
  }

  suspendable(): boolean {
    // TODO: this is wrong
    // return this.future.completed || (!!this.blocked && this.children.every(c => c.suspendable()));
    // return this.blocked?.executor?.kind === "deferred" && this.children.every(c => c.suspendable());
    return false;
  }

  suspend() {}
}

export class OrdinaryExecution<T> extends Execution<T> {
  readonly kind = "ordinary";

  root: ResonateExecution<any>;
  parent: ResonateExecution<any>;

  invocation: Invocation<T>;

  constructor(
    id: string,
    opts: Options,
    parent: ResonateExecution<any>,
    func: (info: Info, ...args: any) => T,
    args: any[] = [],
  ) {
    super(id, opts);
    this.root = parent.root;
    this.parent = parent;

    const info = new Info(this);
    this.invocation = new Invocation(this, () => func(info, args));
  }

  suspendable(): boolean {
    return this.future.completed;
  }

  suspend() {}
}

export class DeferredExecution<T> extends Execution<T> {
  readonly kind = "deferred";

  root: ResonateExecution<any>;
  parent: ResonateExecution<any>;

  private interval?: number;

  constructor(id: string, opts: Options, parent: ResonateExecution<any>) {
    super(id, opts);
    this.root = parent.root;
    this.parent = parent;
  }

  suspendable(): boolean {
    return true;
  }

  suspend() {
    clearInterval(this.interval);
  }

  poll(store: IStore, delay: number = 1000) {
    if (!this.interval) {
      this.interval = +setInterval(() => this._poll(store), delay);
    }
  }

  private async _poll(store: IStore) {
    console.log("poll promise store");

    try {
      const promise = await store.promises.get(this.future.id);
      if (promise.state !== "PENDING") {
        this.sync(promise);
        this.suspend();
      }
    } catch (e) {
      // TODO: log
    }
  }
}
