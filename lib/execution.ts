import { Future, FutureResolvers } from "./future";
import { IStore } from "./core/store";
import { ResonateBase } from "./resonate";
import { DurablePromise } from "./core/promise";

/////////////////////////////////////////////////////////////////////
// Info
/////////////////////////////////////////////////////////////////////

export class Info {
  constructor(private execution: OrdinaryExecution<any>) {}

  get id() {
    return this.execution.id;
  }

  get idempotency() {
    return this.execution.id;
  }

  get timeout() {
    return Number.MAX_SAFE_INTEGER;
  }

  get attempt() {
    return this.execution.attempt;
  }
}

/////////////////////////////////////////////////////////////////////
// Invocation
/////////////////////////////////////////////////////////////////////

export class Invocation<I, T> {
  constructor(
    private func: (info: I, ...args: any) => T,
    private info: I,
    private args: any[],
  ) {}

  async invoke(): Promise<T> {
    return this.func(this.info, ...this.args);
  }
}

/////////////////////////////////////////////////////////////////////
// Execution
/////////////////////////////////////////////////////////////////////

export abstract class Execution<T> {
  createdAt: Date = new Date();

  abstract readonly kind: "ordinary" | "resonate" | "deferred";
  abstract root: ResonateExecution<any>;
  abstract parent: ResonateExecution<any> | null;

  constructor(
    public id: string,
    public future: Future<T>,
    public resolvers: FutureResolvers<T>,
    public store: IStore,
  ) {
    this.future.setExecutor(this);
  }

  abstract suspendable(): boolean;
  abstract suspend(): void | Promise<void>;

  get killed(): boolean {
    return this.root._killed;
  }

  setParent(execution: ResonateExecution<any>) {
    this.parent = execution;
    this.future.setParent(execution.future);
  }

  kill(error: unknown) {
    this.root._killed = true;
    this.root._reject?.(error);
  }

  async resolve(value: any) {
    try {
      const promise = await this.store.promises.resolve(this.id, this.id, false, undefined, JSON.stringify(value));
      this.sync(promise);
    } catch (error) {
      this.kill(error);
    }
  }

  async reject(error: unknown) {
    try {
      const promise = await this.store.promises.reject(this.id, this.id, false, undefined, JSON.stringify(error));
      this.sync(promise);
    } catch (error) {
      this.kill(error);
    }
  }

  sync(promise: DurablePromise) {
    switch (promise.state) {
      case "RESOLVED":
        this.resolvers.resolve(promise.value.data ? JSON.parse(promise.value.data) : undefined);
        break;
      case "REJECTED":
        this.resolvers.reject(promise.value.data ? JSON.parse(promise.value.data) : undefined);
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
  children: Execution<any>[] = [];

  counter: number = 0;

  _killed: boolean = false;
  _reject?: (v: unknown) => void;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    store: IStore,
    parent: ResonateExecution<any> | null,
    reject?: (v: unknown) => void,
  ) {
    super(id, future, resolvers, store);
    this.root = parent?.root ?? this;
    this.parent = parent;
    this._reject = reject;
  }

  addChild(execution: Execution<any>) {
    this.children.push(execution);
    this.future.addChild(execution.future);
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

  attempt: number = 0;

  invocation: Invocation<Info, T>;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    store: IStore,
    parent: ResonateExecution<any>,
    func: (info: Info, ...args: any) => T,
    args: any[] = [],
  ) {
    super(id, future, resolvers, store);
    this.root = parent.root;
    this.parent = parent;

    this.invocation = new Invocation(func, new Info(this), args);
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

  store: IStore;
  private interval?: number;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    store: IStore,
    parent: ResonateExecution<any>,
    delay: number = 1000,
  ) {
    super(id, future, resolvers, store);
    this.root = parent.root;
    this.parent = parent;
    this.store = store;

    if (future.pending) {
      // start a poller
      this.interval = +setInterval(() => this.poll(), delay);
    }
  }

  suspendable(): boolean {
    return true;
  }

  suspend() {
    clearInterval(this.interval);
  }

  private async poll() {
    console.log("poll promise store");

    try {
      const promise = await this.store.promises.get(this.future.id);
      if (promise.state !== "PENDING") {
        this.sync(promise);
        this.suspend();
      }
    } catch (e) {
      // TODO: log
    }
  }
}
