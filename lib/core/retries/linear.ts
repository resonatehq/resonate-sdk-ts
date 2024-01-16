import { Context } from "../../resonate";
import { IRetry, IterableRetry } from "../retry";

export class LinearRetry extends IterableRetry implements IRetry {
  constructor(
    private delay: number,
    private maxAttempts: number = Infinity,
  ) {
    super();
  }

  next(ctx: Context): { done: boolean; delay?: number } {
    if (Date.now() >= ctx.timeout || ctx.attempt >= this.maxAttempts) {
      return { done: true };
    }

    return {
      done: false,
      delay: ctx.attempt === 0 ? 0 : this.delay,
    };
  }
}
