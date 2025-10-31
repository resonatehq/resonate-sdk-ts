import { type Context as TraceContext, trace } from "@opentelemetry/api";
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
    traceContext: TraceContext,
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
    traceContext: TraceContext,
  ): void {
    void this.run(id, name, func, cb, retryPolicy, timeout, verbose, traceContext);
  }

  private async run<T>(
    id: string,
    name: string,
    func: () => Promise<T>,
    cb: (result: Result<T>) => void,
    retryPolicy: RetryPolicy,
    timeout: number,
    verbose: boolean,
    traceContext: TraceContext,
  ) {
    let attempt = 1;

    const t = trace.getTracer("resonate");
    while (true) {
      let retryIn: number | null = 0;
      const span = t.startSpan(`${id}::${attempt}`, {}, traceContext);
      span.setAttribute("attempt", attempt);

      try {
        const data = await func();
        cb({ success: true, value: data });
        return;
      } catch (error) {
        retryIn = retryPolicy.next(attempt);
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
      } finally {
        span.end();
      }

      await new Promise((resolve) => setTimeout(resolve, retryIn));
      attempt++;
    }
  }
}
