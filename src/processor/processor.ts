import type { RetryPolicy } from "../retries";
import type { Result } from "../types";

type F = () => Promise<unknown>;

export interface Processor {
  process(id: string, name: string, func: F, cb: (result: Result<unknown>) => void, retryPolicy: RetryPolicy): void;
}

export class AsyncProcessor implements Processor {
  private seen = new Set<string>();

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

    void this.run(id, name, func, cb, retryPolicy);
  }

  private async run<T>(
    id: string,
    name: string,
    func: () => Promise<T>,
    cb: (result: Result<T>) => void,
    retryPolicy: RetryPolicy,
  ) {
    let attempt = 0;

    while (true) {
      attempt++;
      this.seen.add(id);

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
        console.log(`RuntimeError. Function ${name} failed with '${String(error)}' (retrying in ${retryIn}s)`);
        await new Promise((resolve) => setTimeout(resolve, retryIn * 1000));
      }
    }
  }
}
