import { Future, FutureResolvers } from "./future";
import { IStore } from "./core/store";

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
// Execution
/////////////////////////////////////////////////////////////////////

export class Invocation<T> {
  constructor(
    private func: (...args: any) => T,
    private args: any[],
  ) {}

  async invoke(): Promise<T> {
    return this.func(...this.args);
  }
}

export abstract class Execution<T> {
  abstract readonly kind: "ordinary" | "resonate" | "deferred";
  abstract root: ResonateExecution<any>;
  abstract parent: ResonateExecution<any> | null;

  createdAt: Date = new Date();
  private _killed: boolean = false;

  constructor(
    public id: string,
    public future: Future<T>,
    public resolvers: FutureResolvers<T>,
    private _reject?: (v: unknown) => void,
  ) {
    this.future.setExecutor(this);
  }

  abstract suspendable(): boolean;
  abstract suspend(): void | Promise<void>;

  setParent(execution: ResonateExecution<any>) {
    this.parent = execution;
    this.future.setParent(execution.future);
  }

  kill(error: unknown) {
    this.root._killed = true;
    this.root._reject?.(error);
  }

  get killed(): boolean {
    return this.root._killed;
  }
}

export class ResonateExecution<T> extends Execution<T> {
  readonly kind = "resonate";

  root: ResonateExecution<any>;
  parent: ResonateExecution<any> | null;
  children: Execution<any>[] = [];

  counter: number = 0;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    parent: ResonateExecution<any> | null,
    reject?: (v: unknown) => void,
  ) {
    super(id, future, resolvers, reject);
    this.root = parent?.root ?? this;
    this.parent = parent;
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

  invocation: Invocation<T>;

  constructor(
    id: string,
    future: Future<T>,
    resolvers: FutureResolvers<T>,
    parent: ResonateExecution<any>,
    func: (info: Info, ...args: any) => any,
    args: any[] = [],
  ) {
    super(id, future, resolvers);
    this.root = parent.root;
    this.parent = parent;

    this.invocation = new Invocation(func, [new Info(this), ...args]);
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
    parent: ResonateExecution<any>,
    store: IStore,
    delay: number = 1000,
  ) {
    super(id, future, resolvers);
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
        // this.future.set(promise);
        this.suspend();
      }
    } catch (e) {
      // TODO: log
    }
  }
}
