import { DurablePromise } from "./core/durablePromise";
import { Execution } from "./execution";

/////////////////////////////////////////////////////////////////////
// Promise
/////////////////////////////////////////////////////////////////////

export class ResonatePromise<T> extends Promise<T> {
  // resolves to the id of the durable promise
  // can be used to await durable promise creation
  created: Promise<string>;
  completed: Promise<string>;

  // You are not expected to understand this (we don't either)
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/@@species
  static [Symbol.species] = Promise;

  constructor(
    public id: string,
    bind: Promise<DurablePromise<T>>,
    executor: (resolve: (v: T) => void, reject: (v?: unknown) => void) => void,
  ) {
    super(executor);
    this.created = bind.then((p) => p.created).then((p) => p.id);
    this.completed = bind.then((p) => p.completed).then((p) => p.id);
  }

  // returns a promise and its resolvers, inspired by javascripts Promise.withResolvers
  static deferred<T>(id: string, bind: Promise<DurablePromise<T>>) {
    let resolve!: (v: T) => void;
    let reject!: (v?: unknown) => void;

    const promise = new ResonatePromise<T>(id, bind, (_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
    });

    return { promise, resolve, reject };
  }
}

/////////////////////////////////////////////////////////////////////
// Future
/////////////////////////////////////////////////////////////////////

export class Future<T> {
  // a discriminate property used for yielded
  readonly kind = "future";

  // the underlying promise and its resolvers that this future wraps
  id: string;
  promise: ResonatePromise<T>;

  constructor(private executor: Execution<T>) {
    this.id = executor.id;

    this.promise = new ResonatePromise<T>(this.id, executor.promise, (resolve, reject) => {
      executor.promise
        .then((p) => p.completed)
        .then((p) => (p.resolved ? resolve(p.value) : reject(p.error)))
        .catch(() => {});
    });
  }

  get root() {
    return this.executor.root.future;
  }

  get parent() {
    return this.executor.parent?.future ?? null;
  }

  get children() {
    return this.executor.children.map((e) => e.future);
  }
}
