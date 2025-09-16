import type { RetryPolicy } from "../retries";
import type { Result } from "../types";

type F = () => Promise<unknown>;

export interface Processor {
  process(id: string, name: string, func: F, cb: (result: Result<unknown>) => void, retryPolicy: RetryPolicy): void;
}

export class AsyncProcessor implements Processor {
  process<T>(
    id: string,
    name: string,
    func: () => Promise<T>,
    cb: (result: Result<T>) => void,
    retryPolicy: RetryPolicy,
  ): void {
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
    let error: any = undefined;
    while (true) {
      const retryIn = retryPolicy.next(attempt);
      if (retryIn === null) {
        cb({ success: false, error });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, retryIn));

      try {
        const data = await func();
        cb({ success: true, value: data });
        return;
      } catch (e) {
        error = e;
        attempt++;
        console.log(
          `RuntimeError. Function ${name} failed with '${String(error)}' (retrying in ${retryIn / 1000} secs)`,
        );
      }
    }
  }
}
