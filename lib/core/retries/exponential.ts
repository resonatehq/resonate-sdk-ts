import { Context } from "../../resonate";
import { IRetry, IterableRetry } from "../retry";

export class ExponentialRetry extends IterableRetry implements IRetry {
  constructor(
    private maxAttempts: number,
    private maxDelay: number,
    private initialDelay: number,
    private backoffFactor: number,
  ) {
    super();
  }

  static atMostOnce(): ExponentialRetry {
    return new ExponentialRetry(1, 0, 0, 0);
  }

  static atLeastOnce(
    maxAttempts: number = Infinity,
    maxDelay: number = 60000, // 1 minute
    initialDelay: number = 100,
    backoffFactor: number = 2,
  ): ExponentialRetry {
    return new ExponentialRetry(maxAttempts, maxDelay, initialDelay, backoffFactor);
  }

  next(ctx: Context): { done: boolean; delay?: number } {
    if (Date.now() >= ctx.timeout || ctx.attempt >= this.maxAttempts) {
      return { done: true };
    }

    const delay = Math.min(ctx.attempt, 1) * this.initialDelay * Math.pow(this.backoffFactor, ctx.attempt - 1);

    return {
      done: false,
      delay: Math.min(delay, this.maxDelay),
    };
  }
}
