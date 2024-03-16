import { Invocation } from "./invocation";

/////////////////////////////////////////////////////////////////////
// Promise
/////////////////////////////////////////////////////////////////////

export class ResonatePromise<T> extends Promise<T> {
  // resolves to the id of the durable promise
  // can be used to await durable promise creation
  created: Promise<string>;

  // You are not expected to understand this (we don't either)
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/@@species
  static [Symbol.species] = Promise;

  constructor(
    public id: string,
    created: Promise<any>,
    completed: Promise<T>,
  ) {
    super((resolve, reject) => {
      completed.then(resolve, reject);
    });

    this.created = created.then(() => this.id);
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

  constructor(
    private invocation: Invocation<T>,
    public promise: Promise<T>,
  ) {
    this.id = invocation.id;
  }

  static deferred<T>(executor: Invocation<T>) {
    let resolve!: (v: T) => void;
    let reject!: (v?: unknown) => void;

    const promise = new Promise<T>((_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
    });

    return { future: new Future(executor, promise), resolve, reject };
  }

  get root() {
    return this.invocation.root.future;
  }

  get parent() {
    return this.invocation.parent?.future ?? null;
  }

  get children() {
    return this.invocation.children.map((i) => i.future);
  }
}
