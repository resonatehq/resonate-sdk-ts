import { Execution } from "./execution";

/////////////////////////////////////////////////////////////////////
// Promise
/////////////////////////////////////////////////////////////////////

export class ResonatePromise<T> extends Promise<T> {
  // resolves to the id of the durable promise
  // can be used to await durable promise creation
  created: Promise<string>;

  constructor(
    public id: string,
    executor: (resolve: (v: T) => void, reject: (v?: unknown) => void) => void,
  ) {
    super(executor);
    this.created = Promise.reject("not created");
    this.created.catch(() => {});
  }

  // You are not expected to understand this (we don't either)
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/@@species
  static get [Symbol.species]() {
    return Promise;
  }

  // returns a promise and its resolvers, inspired by javascripts Promise.withResolvers
  static withResolvers<T>(id: string) {
    let resolve!: (v: T) => void;
    let reject!: (v?: unknown) => void;

    const promise = new ResonatePromise<T>(id, (_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
    });

    return { promise, resolve, reject };
  }
}

/////////////////////////////////////////////////////////////////////
// Future
/////////////////////////////////////////////////////////////////////

// all possible future states, these states extend the javscript promise model, but can be mapped
// to a javascript promise
// pending  -> pending
// resolved -> resolved
// rejected -> rejected
// canceled -> rejected
// timedout -> rejected
type FutureState<T> =
  | { kind: "pending" }
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; value: unknown }
  | { kind: "canceled"; value: unknown }
  | { kind: "timedout"; value: unknown };

export type FutureResolvers<T> = {
  resolve: (value: T) => void;
  reject: (value: unknown) => void;
  cancel: (value: unknown) => void;
  timeout: (value: unknown) => void;
};

export class Future<T> {
  // a discriminate property used for yielded
  readonly kind = "future";

  // the underlying promise and its resolvers that this future wraps
  promise: ResonatePromise<T>;
  private resolvePromise: (v: T) => void;
  private rejectPromise: (v: unknown) => void;

  // the parent future of this future
  parent: Future<any> | null = null;

  // all child futures of this future
  children: Future<any>[] = [];

  // the execution associated with this future
  executor: Execution<T> | null = null;

  // the state of the future
  private _state: FutureState<T> = { kind: "pending" };

  constructor(public id: string) {
    const { promise, resolve, reject } = ResonatePromise.withResolvers<T>(id);
    this.promise = promise;
    this.resolvePromise = resolve;
    this.rejectPromise = reject;
  }

  static withResolvers<T>(id: string): { future: Future<T>; resolvers: FutureResolvers<T> } {
    const future = new Future<T>(id);

    return {
      future,
      resolvers: {
        resolve: future.resolve.bind(future),
        reject: future.reject.bind(future),
        cancel: future.cancel.bind(future),
        timeout: future.timeout.bind(future),
      },
    };
  }

  private resolve(value: T) {
    this._state = { kind: "resolved", value };
    this.resolvePromise(value);
  }

  private reject(value: unknown) {
    this._state = { kind: "rejected", value };
    this.rejectPromise(value);
  }

  private cancel(value: unknown) {
    const error = new Error(`canceled: ${value}`);
    this._state = { kind: "canceled", value };
    this.rejectPromise(error);
  }

  private timeout(value: unknown) {
    const error = new Error(`timedout: ${value}`);
    this._state = { kind: "timedout", value };
    this.rejectPromise(error);
  }

  // onComplete(onResolved: (value: T) => void, onRejected: (value: unknown) => void) {
  //     this.promise.then(onResolved, onRejected);
  // }

  get pending() {
    return this._state.kind === "pending";
  }

  get resolved() {
    return this._state.kind === "resolved";
  }

  get rejected() {
    return this._state.kind === "rejected";
  }

  get canceled() {
    return this._state.kind === "canceled";
  }

  get timedout() {
    return this._state.kind === "timedout";
  }

  get completed() {
    return !this.pending;
  }

  // should probably remove
  get state() {
    return this._state.kind;
  }

  // should probably remove
  get value() {
    return this._state.kind === "pending" ? undefined : this._state.value;
  }

  setExecutor(execution: Execution<T>) {
    this.executor = execution;
  }

  setParent(future: Future<any>) {
    this.parent = future;
  }

  addChild(future: Future<any>) {
    this.children.push(future);
  }
}
