import type * as context from "../context.js";
import type { Span } from "../tracer.js";
import type { Result } from "../types.js";
import * as util from "../util.js";

type F = () => Promise<unknown>;

type WorkItem = { id: string; ctx: context.InnerContext; func: F; span: Span; verbose: boolean };

export interface Processor {
  process(work: WorkItem[]): void;
  getReady(ids: string[], cb: (results: { id: string; result: Result<unknown, any> }[]) => void): void;
}

export class AsyncProcessor implements Processor {
  private results: Map<string, Result<unknown, any>> = new Map();
  private pending: Set<string> = new Set();
  private completed: Set<string> = new Set();
  private waiter: { ids: Set<string>; cb: (results: { id: string; result: Result<unknown, any> }[]) => void } | null =
    null;

  process(work: WorkItem[]): void {
    for (const item of work) {
      if (this.completed.has(item.id) || this.pending.has(item.id)) {
        continue;
      }

      this.pending.add(item.id);
      this.executeWork(item.id, item.ctx, item.func, item.span, item.verbose).then(
        (result) => this.complete(item.id, result),
        (error) => this.complete(item.id, { kind: "error", error }),
      );
    }
  }

  getReady(ids: string[], cb: (results: { id: string; result: Result<unknown, any> }[]) => void): void {
    util.assert(!this.waiter, "AsyncProcessor already has a pending getReady call");

    const ready = this.drain(ids);

    if (ready.length > 0) {
      cb(ready);
      return;
    }

    this.waiter = { ids: new Set(ids), cb };
  }

  private complete(id: string, result: Result<unknown, any>): void {
    this.pending.delete(id);
    this.completed.add(id);
    this.results.set(id, result);
    this.notifyWaiter(id);
  }

  private notifyWaiter(completedId: string): void {
    if (this.waiter === null || !this.waiter.ids.has(completedId)) {
      return;
    }

    const ready = this.drain([...this.waiter.ids]);
    const cb = this.waiter.cb;
    this.waiter = null;

    if (ready.length > 0) {
      cb(ready);
    }
  }

  private drain(ids: string[]): { id: string; result: Result<unknown, any> }[] {
    const ready: { id: string; result: Result<unknown, any> }[] = [];

    for (const id of ids) {
      const result = this.results.get(id);
      if (result !== undefined) {
        ready.push({ id, result });
        this.results.delete(id);
      }
    }

    return ready;
  }

  private async executeWork(
    id: string,
    ctx: context.InnerContext,
    func: () => Promise<unknown>,
    span: Span,
    verbose: boolean,
  ): Promise<Result<unknown, any>> {
    while (true) {
      const childSpan = span.startSpan(`${id}::${ctx.info.attempt}`, ctx.clock.now());
      childSpan.setAttribute("attempt", ctx.info.attempt);

      try {
        const data = await func();
        childSpan.setStatus(true);
        return { kind: "value", value: data };
      } catch (error) {
        childSpan.setStatus(false, String(error));

        const retryIn = ctx.retryPolicy.next(ctx.info.attempt);
        if (retryIn === null || ctx.clock.now() + retryIn >= ctx.info.timeout) {
          return { kind: "error", error };
        }

        console.warn(
          `Runtime. Function '${ctx.func}' failed with '${String(error)}' (retrying in ${retryIn / 1000} secs)`,
        );
        if (verbose) {
          console.warn(error);
        }

        ctx.info.attempt++;
        await new Promise((resolve) => setTimeout(resolve, retryIn));
      } finally {
        childSpan.end(ctx.clock.now());
      }
    }
  }
}
