import { Future, ResonatePromise } from "./future";
import { Invocation } from "./invocation";
import { DurablePromise } from "./promises/promises";
import { IRetry } from "./retry";

/////////////////////////////////////////////////////////////////////
// Execution
/////////////////////////////////////////////////////////////////////

export abstract class Execution<T> {
  constructor(public invocation: Invocation<T>) {}

  execute() {
    const forkPromise = this.fork();
    const joinPromise = forkPromise.then((f) => this.join(f));

    return new ResonatePromise(this.invocation.id, forkPromise, joinPromise);
  }

  abstract fork(): Promise<Future<T>>;
  abstract join(future: Future<T>): Promise<T>;
}

export class OrdinaryExecution<T> extends Execution<T> {
  constructor(
    invocation: Invocation<T>,
    private func: () => T,
    private retry: IRetry = invocation.opts.retry,
  ) {
    super(invocation);
  }

  async invoke(): Promise<T> {
    let error;

    for (const delay of this.retry.iterator(this.invocation)) {
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return await this.func();
      } catch (e) {
        error = e;
        this.invocation.attempt++;
      }
    }

    throw error;
  }

  async fork() {
    try {
      const promise = await DurablePromise.create<T>(
        this.invocation.opts.store.promises,
        this.invocation.opts.encoder,
        this.invocation.id,
        this.invocation.opts.timeout,
        { idempotencyKey: this.invocation.idempotencyKey },
      );

      if (promise.pending) {
        await this.invoke().then(
          (v) => promise.resolve(v, { idempotencyKey: this.invocation.idempotencyKey }),
          (e) => promise.reject(e, { idempotencyKey: this.invocation.idempotencyKey }),
        );
      }

      if (promise.resolved) {
        this.invocation.resolve(promise.value);
      } else if (promise.rejected || promise.canceled || promise.timedout) {
        this.invocation.reject(promise.error);
      }
    } catch (e) {
      this.invocation.kill(e);
    }

    return this.invocation.future;
  }

  async join(future: Future<T>) {
    return await future.promise;
  }
}

export class DeferredExecution<T> extends Execution<T> {
  constructor(invocation: Invocation<T>) {
    super(invocation);
  }

  async fork() {
    try {
      const promise = await DurablePromise.create<T>(
        this.invocation.opts.store.promises,
        this.invocation.opts.encoder,
        this.invocation.id,
        this.invocation.opts.timeout,
        { idempotencyKey: this.invocation.idempotencyKey, poll: true },
      );

      promise.completed.then((p) => (p.resolved ? this.invocation.resolve(p.value) : this.invocation.reject(p.error)));
    } catch (e) {
      this.invocation.kill(e);
    }

    return this.invocation.future;
  }

  async join(future: Future<T>) {
    return await future.promise;
  }
}

export class GeneratorExecution<T> extends Execution<T> {
  constructor(
    invocation: Invocation<T>,
    public generator: Generator<any, T>,
  ) {
    super(invocation);
  }

  async create() {
    try {
      const promise = await DurablePromise.create<T>(
        this.invocation.opts.store.promises,
        this.invocation.opts.encoder,
        this.invocation.id,
        this.invocation.opts.timeout,
        { idempotencyKey: this.invocation.idempotencyKey },
      );

      if (promise.resolved) {
        this.invocation.resolve(promise.value);
      } else if (promise.rejected || promise.canceled || promise.timedout) {
        this.invocation.reject(promise.error);
      }
      return promise;
    } catch (e) {
      this.invocation.kill(e);
    }
  }

  async resolve(promise: DurablePromise<T>, value: T) {
    try {
      await promise.resolve(value, { idempotencyKey: this.invocation.idempotencyKey });

      if (promise.resolved) {
        this.invocation.resolve(promise.value);
      } else if (promise.rejected || promise.canceled || promise.timedout) {
        this.invocation.reject(promise.error);
      }
    } catch (e) {
      this.invocation.kill(e);
    }

    return promise;
  }

  async reject(promise: DurablePromise<T>, error: any) {
    try {
      await promise.resolve(error, { idempotencyKey: this.invocation.idempotencyKey });

      if (promise.resolved) {
        this.invocation.resolve(promise.value);
      } else if (promise.rejected || promise.canceled || promise.timedout) {
        this.invocation.reject(promise.error);
      }
    } catch (e) {
      this.invocation.kill(e);
    }

    return promise;
  }

  async fork() {
    return this.invocation.future;
  }

  async join(future: Future<T>) {
    return await future.promise;
  }
}
