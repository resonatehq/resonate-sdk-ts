import type * as context from "../context.js";
import type { Span } from "../tracer.js";
import type { Result } from "../types.js";
import * as util from "../util.js";

type F = () => Promise<unknown>;

export interface Processor {
  process(work: { id: string; ctx: context.InnerContext; func: F; span: Span; verbose: boolean }[]): void;
  getReady(ids: string[], cb: (results: { id: string; result: Result<unknown, any> }[]) => void): void;
}

export class AsyncProcessor implements Processor {
  private results: Map<string, Result<unknown, any>> = new Map();
  private pending: Set<string> = new Set();
  private waiter: { ids: Set<string>; cb: (results: { id: string; result: Result<unknown, any> }[]) => void } | null =
    null;

  process(work: { id: string; ctx: context.InnerContext; func: F; span: Span; verbose: boolean }[]): void {
    for (const item of work) {
      if (this.results.has(item.id) || this.pending.has(item.id)) {
        continue;
      }

      this.pending.add(item.id);
      this.executeWork(item.id, item.ctx, item.func, item.span, item.verbose).then((result) => {
        this.pending.delete(item.id);
        this.results.set(item.id, result);
        this.notifyWaiter(item.id);
      });
    }
  }

  getReady(ids: string[], cb: (results: { id: string; result: Result<unknown, any> }[]) => void): void {
    // Assert no concurrent waiters
    util.assert(!this.waiter, "AsyncProcessor already has a pending getReady call");

    const ready: { id: string; result: Result<unknown, any> }[] = [];
    const idsSet = new Set(ids);

    for (const id of ids) {
      if (this.results.has(id)) {
        ready.push({ id, result: this.results.get(id)! });
        idsSet.delete(id);
      }
    }

    // If we have at least one result, return immediately
    if (ready.length > 0) {
      cb(ready);
      return;
    }

    // Otherwise, register to wait for any of the remaining IDs
    this.waiter = { ids: idsSet, cb };
  }

  private notifyWaiter(completedId: string): void {
    if (this.waiter === null || !this.waiter.ids.has(completedId)) {
      return;
    }

    const ready: { id: string; result: Result<unknown, any> }[] = [];

    for (const id of this.waiter.ids) {
      if (this.results.has(id)) {
        ready.push({ id, result: this.results.get(id)! });
      }
    }

    // Clear the waiter before calling the callback to avoid re-entrance issues
    const cb = this.waiter.cb;
    this.waiter = null;

    if (ready.length > 0) {
      cb(ready);
    }
  }

  private async executeWork(
    id: string,
    ctx: context.InnerContext,
    func: () => Promise<unknown>,
    span: Span,
    verbose: boolean,
  ): Promise<Result<unknown, any>> {
    while (true) {
      let retryIn: number | null = null;
      const childSpan = span.startSpan(`${id}::${ctx.info.attempt}`, ctx.clock.now());
      childSpan.setAttribute("attempt", ctx.info.attempt);

      try {
        const data = await func();
        childSpan.setStatus(true);
        childSpan.end(ctx.clock.now());
        return { kind: "value", value: data };
      } catch (error) {
        childSpan.setStatus(false, String(error));

        retryIn = ctx.retryPolicy.next(ctx.info.attempt);
        if (retryIn === null) {
          childSpan.end(ctx.clock.now());
          return { kind: "error", error: error };
        }

        // Use the same clock sourced from ctx for consistency
        if (ctx.clock.now() + retryIn >= ctx.info.timeout) {
          childSpan.end(ctx.clock.now());
          return { kind: "error", error: error };
        }

        console.warn(
          `Runtime. Function '${ctx.func}' failed with '${String(error)}' (retrying in ${retryIn / 1000} secs)`,
        );
        if (verbose) {
          console.warn(error);
        }

        childSpan.end(ctx.clock.now());
      }

      // Ensure a numeric delay for setTimeout; guard against null just in case
      await new Promise((resolve) => setTimeout(resolve, retryIn ?? 0));
      ctx.info.attempt++;
    }
  }
}
