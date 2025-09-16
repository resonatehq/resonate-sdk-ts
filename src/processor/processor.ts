import type { RetryPolicy } from "../retries";
import type { Result } from "../types";

type F = () => Promise<unknown>;

export interface Processor {
  process(id: string, name: string, func: F, cb: (result: Result<unknown>) => void, retryPolicy: RetryPolicy): void;
}

export class AsyncProcessor implements Processor {
  private seen = new Map<string, number>();

  process<T>(
    id: string,
    name: string,
    func: () => Promise<T>,
    cb: (result: Result<T>) => void,
    retryPolicy: RetryPolicy,
  ): void {
    if (this.seen.has(id)) {
      return;
    }

    this.run(id, name, func, cb, retryPolicy);
  }

  private run<T>(
    id: string,
    name: string,
    func: () => Promise<T>,
    cb: (result: Result<T>) => void,
    retryPolicy: RetryPolicy,
  ) {
    const attempt = (this.seen.get(id) ?? 0) + 1;
    this.seen.set(id, attempt);

    func()
      .then((data) => {
        cb({ success: true, value: data });
      })
      .catch((error) => {
        const retryIn = retryPolicy.next(attempt);
        if (retryIn === null) {
          cb({ success: false, error });
        } else {
          console.log(`RuntimeError. Function ${name} failed with '${String(error)}' (retrying in ${retryIn}s)`);
          setTimeout(() => this.run(id, name, func, cb, retryPolicy), retryIn * 1000);
        }
      });
  }
}
