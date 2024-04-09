import { ErrorCodes, ResonateError } from "./errors";
import { Future, ResonatePromise } from "./future";
import { Invocation } from "./invocation";
import { DurablePromise } from "./promises/promises";
import { IRetry } from "./retry";

/////////////////////////////////////////////////////////////////////
// Execution
/////////////////////////////////////////////////////////////////////

export abstract class Execution<T> {
  private promise: ResonatePromise<T> | null = null;

  /**
   * Represents an execution of a Resonate function invocation.
   *
   * @constructor
   * @param invocation - An invocation correpsonding to the Resonate function.
   */
  constructor(public invocation: Invocation<T>) {}

  execute(): ResonatePromise<T> {
    if (this.promise) {
      return this.promise;
    }

    const forkPromise = this.fork();
    const joinPromise = forkPromise.then((f) => this.join(f));

    this.promise = new ResonatePromise(this.invocation.id, forkPromise, joinPromise);
    return this.promise;
  }

  protected abstract fork(): Promise<Future<T>>;
  protected abstract join(future: Future<T>): Promise<T>;

  get killed() {
    return this.invocation.root.killed;
  }

  kill(error: unknown) {
    // this will mark the entire invocation tree as killed
    this.invocation.root.killed = true;

    // reject only the root invocation
    this.invocation.root.reject(new ResonateError("Resonate function killed", ErrorCodes.KILLED, error, true));
  }

  protected tags() {
    if (this.invocation.parent === null) {
      return { ...this.invocation.opts.tags, "resonate:invocation": "true" };
    }

    return this.invocation.opts.tags;
  }
}

export class OrdinaryExecution<T> extends Execution<T> {
  constructor(
    invocation: Invocation<T>,
    private func: () => T,
    private retry: IRetry = invocation.opts.retry,
  ) {
    super(invocation);
  }

  protected async fork() {
    if (this.invocation.opts.durable) {
      // create a durable promise if the invocation is durable
      try {
        const promise = await DurablePromise.create<T>(
          this.invocation.opts.store.promises,
          this.invocation.opts.encoder,
          this.invocation.id,
          this.invocation.timeout,
          {
            idempotencyKey: this.invocation.idempotencyKey,
            headers: this.invocation.headers,
            param: this.invocation.param,
            tags: this.tags(),
          },
        );

        if (promise.pending) {
          // if pending, invoke the function and resolve/reject the durable promise
          try {
            await promise.resolve(await this.run(), { idempotencyKey: this.invocation.idempotencyKey });
          } catch (e) {
            await promise.reject(e, { idempotencyKey: this.invocation.idempotencyKey });
          }
        }

        // resolve/reject the invocation
        if (promise.resolved) {
          this.invocation.resolve(promise.value());
        } else if (promise.rejected || promise.canceled || promise.timedout) {
          this.invocation.reject(promise.error());
        }
      } catch (e) {
        // if an error occurs, kill the execution
        this.kill(e);
      }
    } else {
      // if not durable, invoke the function and resolve/reject the invocation
      try {
        this.invocation.resolve(await this.run());
      } catch (e) {
        this.invocation.reject(e);
      }
    }

    return this.invocation.future;
  }

  protected async join(future: Future<T>) {
    return await future.promise;
  }

  private async run(): Promise<T> {
    const opts = this.invocation.opts;

    // acquire lock if necessary
    while (opts.lock && !(await opts.store.locks.tryAcquire(this.invocation.id, opts.eid))) {
      await new Promise((resolve) => setTimeout(resolve, opts.poll));
    }

    return this._run().finally(async () => {
      // release lock if necessary
      if (opts.lock) {
        try {
          await opts.store.locks.release(this.invocation.id, opts.eid);
        } catch (e) {
          opts.logger.warn("Failed to release lock", e);
        }
      }
    });
  }

  private async _run(): Promise<T> {
    let error;

    // invoke the function according to the retry policy
    for (const delay of this.retry.iterator(this.invocation)) {
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        return await this.func();
      } catch (e) {
        error = e;

        // bump the attempt count
        this.invocation.attempt++;
      }
    }

    // if all attempts fail throw the last error
    throw error;
  }
}

export class DeferredExecution<T> extends Execution<T> {
  constructor(invocation: Invocation<T>) {
    super(invocation);
  }

  protected async fork() {
    try {
      // create a durable promise
      const promise = await DurablePromise.create<T>(
        this.invocation.opts.store.promises,
        this.invocation.opts.encoder,
        this.invocation.id,
        this.invocation.timeout,
        {
          idempotencyKey: this.invocation.idempotencyKey,
          headers: this.invocation.headers,
          param: this.invocation.param,
          tags: this.tags(),
          poll: this.invocation.opts.poll,
        },
      );

      // poll the completion of the durable promise
      promise.completed.then((p) =>
        p.resolved ? this.invocation.resolve(p.value()) : this.invocation.reject(p.error()),
      );
    } catch (e) {
      // if an error occurs, kill the execution
      this.kill(e);
    }

    return this.invocation.future;
  }

  protected async join(future: Future<T>) {
    return await future.promise;
  }
}

export class GeneratorExecution<T> extends Execution<T> {
  private durablePromise: DurablePromise<T> | null = null;

  constructor(
    invocation: Invocation<T>,
    public generator: Generator<any, T>,
  ) {
    super(invocation);
  }

  async create() {
    if (this.invocation.opts.durable) {
      // create a durable promise if the invocation is durable
      try {
        // create a durable promise
        this.durablePromise = await DurablePromise.create<T>(
          this.invocation.opts.store.promises,
          this.invocation.opts.encoder,
          this.invocation.id,
          this.invocation.timeout,
          {
            idempotencyKey: this.invocation.idempotencyKey,
            headers: this.invocation.headers,
            param: this.invocation.param,
            tags: this.tags(),
          },
        );

        // resolve/reject the invocation if already completed
        if (this.durablePromise.resolved) {
          this.invocation.resolve(this.durablePromise.value());
        } else if (this.durablePromise.rejected || this.durablePromise.canceled || this.durablePromise.timedout) {
          this.invocation.reject(this.durablePromise.error());
        }

        // acquire lock if necessary
        while (
          this.invocation.opts.lock &&
          this.durablePromise.pending &&
          !(await this.invocation.opts.store.locks.tryAcquire(this.invocation.id, this.invocation.opts.eid))
        ) {
          await new Promise((resolve) => setTimeout(resolve, this.invocation.opts.poll));
        }
      } catch (e) {
        // if an error occurs, kill the execution
        this.kill(e);
      }
    }
  }

  async resolve(value: T) {
    if (this.durablePromise) {
      // resolve the durable promise if the invocation is durable
      try {
        // resolve the durable promise
        await this.durablePromise.resolve(value, { idempotencyKey: this.invocation.idempotencyKey });

        // resolve/reject the invocation
        if (this.durablePromise.resolved) {
          this.invocation.resolve(this.durablePromise.value());
        } else if (this.durablePromise.rejected || this.durablePromise.canceled || this.durablePromise.timedout) {
          this.invocation.reject(this.durablePromise.error());
        }
      } catch (e) {
        // if an error occurs, kill the execution
        this.kill(e);
      } finally {
        // release lock if necessary
        if (this.invocation.opts.lock) {
          try {
            await this.invocation.opts.store.locks.release(this.invocation.id, this.invocation.opts.eid);
          } catch (e) {
            this.invocation.opts.logger.warn("Failed to release lock", e);
          }
        }
      }
    } else {
      // if not durbale, just resolve the invocation
      this.invocation.resolve(value);
    }
  }

  async reject(error: any) {
    if (this.durablePromise) {
      // reject the durable promise if the invocation is durable
      try {
        // reject the durable promise
        await this.durablePromise.reject(error, { idempotencyKey: this.invocation.idempotencyKey });

        // resolve/reject the invocation
        if (this.durablePromise.resolved) {
          this.invocation.resolve(this.durablePromise.value());
        } else if (this.durablePromise.rejected || this.durablePromise.canceled || this.durablePromise.timedout) {
          this.invocation.reject(this.durablePromise.error());
        }
      } catch (e) {
        // if an error occurs, kill the execution
        this.kill(e);
      } finally {
        // release lock if necessary
        if (this.invocation.opts.lock) {
          try {
            await this.invocation.opts.store.locks.release(this.invocation.id, this.invocation.opts.eid);
          } catch (e) {
            this.invocation.opts.logger.warn("Failed to release lock", e);
          }
        }
      }
    } else {
      // if not durbale, just reject the invocation
      this.invocation.reject(error);
    }
  }

  protected async fork() {
    return this.invocation.future;
  }

  protected async join(future: Future<T>) {
    return await future.promise;
  }
}
