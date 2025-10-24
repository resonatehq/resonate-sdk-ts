import type { RetryPolicy } from "../retries";
import type { Result } from "../types";

type F = () => Promise<unknown>;

export interface Processor {
  process(
    id: string,
    name: string,
    func: F,
    cb: (result: Result<unknown>) => void,
    retryPolicy: RetryPolicy,
    timeout: number,
    verbose: boolean,
  ): void;
}

export class AsyncProcessor implements Processor {
  process<T>(
    id: string,
    name: string,
    func: () => Promise<T>,
    cb: (result: Result<T>) => void,
    retryPolicy: RetryPolicy,
    timeout: number,
    verbose: boolean,
  ): void {
    void this.run(name, func, cb, retryPolicy, timeout, verbose);
  }

  private async run<T>(
    name: string,
    func: () => Promise<T>,
    cb: (result: Result<T>) => void,
    retryPolicy: RetryPolicy,
    timeout: number,
    verbose: boolean,
  ) {
    let attempt = 1;

    while (true) {
      try {
        const data = await func();
        cb({ success: true, value: data });
        return;
      } catch (error) {
        const retryIn = retryPolicy.next(attempt);
        if (retryIn === null) {
          cb({ success: false, error });
          return;
        }

        if (Date.now() + retryIn >= timeout) {
          cb({ success: false, error });
          return;
        }

        console.warn(`Runtime. Function '${name}' failed with '${String(error)}' (retrying in ${retryIn / 1000} secs)`);
        if (verbose) {
          console.warn(error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryIn));
        attempt++;
      }
    }
  }
}
