import { IEncoder } from "./encoder";
import { PendingPromise, ResolvedPromise, RejectedPromise, CanceledPromise, TimedoutPromise } from "./promise";
import { IPromiseStore } from "./store";

export type CompleteOptions = {
  idempotencyKey: string;
  headers: Record<string, string>;
  strict: boolean;
};

export type CreateOptions = CompleteOptions & {
  param: any;
  tags: Record<string, string>;
};

export class DurablePromise<T> {
  readonly created: Promise<DurablePromise<T>>;
  readonly completed: Promise<DurablePromise<T>>;
  private complete!: (value: DurablePromise<T>) => void;

  constructor(
    private store: IPromiseStore,
    private encoder: IEncoder<unknown, string | undefined>,
    private _promise: PendingPromise | ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise,
  ) {
    this.created = Promise.resolve(this);
    this.completed = new Promise((resolve) => {
      this.complete = resolve;
    });

    this.promise = _promise;
  }

  get id() {
    return this.promise.id;
  }

  get idempotencyKeyForCreate() {
    return this.promise.idempotencyKeyForCreate;
  }

  get idempotencyKeyForComplete() {
    return this.promise.idempotencyKeyForComplete;
  }

  get pending() {
    return this.promise.state === "PENDING";
  }

  get resolved() {
    return this.promise.state === "RESOLVED";
  }

  get rejected() {
    return this.promise.state === "REJECTED";
  }

  get canceled() {
    return this.promise.state === "REJECTED_CANCELED";
  }

  get timedout() {
    return this.promise.state === "REJECTED_TIMEDOUT";
  }

  get value() {
    return this.encoder.decode(this.promise.value.data) as T;
  }

  get error() {
    return this.encoder.decode(this.promise.value.data);
  }

  private get promise() {
    return this._promise;
  }

  private set promise(promise: PendingPromise | ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise) {
    this._promise = promise;
    if (!this.pending) {
      this.complete(this);
    }
  }

  static async get<T>(store: IPromiseStore, encoder: IEncoder<unknown, string | undefined>, id: string) {
    return new DurablePromise<T>(store, encoder, await store.get(id));
  }

  static async create<T>(
    store: IPromiseStore,
    encoder: IEncoder<unknown, string | undefined>,
    id: string,
    timeout: number,
    opts: Partial<CreateOptions> = {},
  ) {
    return new DurablePromise<T>(
      store,
      encoder,
      await store.create(
        id,
        opts.idempotencyKey,
        opts.strict ?? false,
        opts.headers,
        encoder.encode(opts.param),
        timeout,
        opts.tags,
      ),
    );
  }

  static async resolve<T>(
    store: IPromiseStore,
    encoder: IEncoder<unknown, string | undefined>,
    id: string,
    value: T,
    opts: Partial<CompleteOptions> = {},
  ) {
    return new DurablePromise<T>(
      store,
      encoder,
      await store.resolve(id, opts.idempotencyKey, opts.strict ?? false, opts.headers, encoder.encode(value)),
    );
  }

  static async reject<T>(
    store: IPromiseStore,
    encoder: IEncoder<unknown, string | undefined>,
    id: string,
    error: any,
    opts: Partial<CompleteOptions> = {},
  ) {
    return new DurablePromise<T>(
      store,
      encoder,
      await store.reject(id, opts.idempotencyKey, opts.strict ?? false, opts.headers, encoder.encode(error)),
    );
  }

  static async cancel<T>(
    store: IPromiseStore,
    encoder: IEncoder<unknown, string | undefined>,
    id: string,
    error: any,
    opts: Partial<CompleteOptions> = {},
  ) {
    return new DurablePromise<T>(
      store,
      encoder,
      await store.cancel(id, opts.idempotencyKey, opts.strict ?? false, opts.headers, encoder.encode(error)),
    );
  }

  async resolve(value: T, opts: Partial<CompleteOptions> = {}) {
    this.promise = !this.pending
      ? this.promise
      : await this.store.resolve(
          this.id,
          opts.idempotencyKey,
          opts.strict ?? false,
          opts.headers,
          this.encoder.encode(value),
        );
    return this;
  }

  async reject(error: any, opts: Partial<CompleteOptions> = {}) {
    this.promise = !this.pending
      ? this.promise
      : await this.store.reject(
          this.id,
          opts.idempotencyKey,
          opts.strict ?? false,
          opts.headers,
          this.encoder.encode(error),
        );
    return this;
  }

  async cancel(error: any, opts: Partial<CompleteOptions> = {}) {
    this.promise = !this.pending
      ? this.promise
      : await this.store.cancel(
          this.id,
          opts.idempotencyKey,
          opts.strict ?? false,
          opts.headers,
          this.encoder.encode(error),
        );
    return this;
  }
}
