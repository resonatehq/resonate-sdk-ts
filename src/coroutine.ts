import type { Context, InnerContext } from "./context.js";
import { Decorator, type PromiseCompleted, type Value } from "./decorator.js";
import type { PromiseRecord } from "./network/types.js";
import { Never } from "./retries.js";
import type { Effects, Result, Yieldable } from "./types.js";
import * as util from "./util.js";

export type Suspended = {
  type: "suspended";
  todo: { remote: RemoteTodo[] };
};

export type Done = {
  type: "done";
  result: Result<any, any>;
};

export interface RemoteTodo {
  id: string;
}

// a simple map to suppress duplicate warnings, necessary due to
// micro retries
const logged: Map<string, boolean> = new Map();

type LocalWorkEntry = {
  funcName: string;
  promise: Promise<Result<Suspended | Done, any>>;
};

export class Coroutine<T> {
  private ctx: InnerContext;
  private verbose: boolean;
  private decorator: Decorator<T>;
  private effects: Effects;

  constructor(ctx: InnerContext, verbose: boolean, decorator: Decorator<T>, effects: Effects) {
    this.ctx = ctx;
    this.verbose = verbose;
    this.decorator = decorator;
    this.effects = effects;

    if (!(this.ctx.retryPolicy instanceof Never) && !logged.has(this.ctx.id)) {
      console.warn(`Options. Generator function '${this.ctx.func}' does not support retries. Will ignore.`);
      logged.set(this.ctx.id, true);
    }
  }

  public static async exec(
    verbose: boolean,
    ctx: InnerContext,
    func: (ctx: Context, ...args: any[]) => Generator<Yieldable, any, any>,
    args: any[],
    effects: Effects,
  ): Promise<Result<Suspended | Done, any>> {
    const coroutine = new Coroutine(ctx, verbose, new Decorator(func(ctx, ...args)), effects);
    return await coroutine.exec();
  }

  private async exec(): Promise<Result<Suspended | Done, any>> {
    const remote: RemoteTodo[] = [];
    const localWork: Map<string, LocalWorkEntry> = new Map();

    let input: Value<any> = {
      type: "internal.nothing",
    };

    while (true) {
      const action = this.decorator.next(input);

      // Handle internal.async.l (lfi/lfc)
      if (action.type === "internal.async.l") {
        const res = await this.effects.promiseCreate(action.createReq, action.func.name);

        if (res.kind === "error") {
          res.error.log(this.verbose);
          return res;
        }

        const ctx = this.ctx.child({
          id: res.value.id,
          func: action.func.name,
          timeout: res.value.timeoutAt,
          version: action.version,
          retryPolicy: action.retryPolicy,
        });

        if (res.value.state === "pending") {
          // Start local work eagerly — both regular functions and generators
          let localPromise: Promise<Result<Suspended | Done, any>>;

          if (!util.isGeneratorFunction(action.func)) {
            localPromise = util
              .executeWithRetry(ctx, action.func, action.args, this.verbose)
              .then((result): Result<Done, never> => ({ kind: "value", value: { type: "done", result } }));
          } else {
            localPromise = Coroutine.exec(
              this.verbose,
              ctx,
              action.func as (ctx: Context, ...args: any[]) => Generator<Yieldable, any, any>,
              action.args,
              this.effects,
            );
          }

          localWork.set(action.id, { funcName: action.func.name, promise: localPromise });
          input = {
            type: "internal.promise",
            state: "pending",
            mode: "attached",
            id: action.id,
          };
        } else {
          // durable promise is already completed (replay)
          input = this.completedPromise(action.id, res.value);
        }
        continue;
      }

      // Handle internal.async.r
      if (action.type === "internal.async.r") {
        const res = await this.effects.promiseCreate(action.createReq, "unknown");

        if (res.kind === "error") {
          res.error.log(this.verbose);
          return res;
        }

        if (res.value.state === "pending") {
          if (action.mode === "attached") remote.push({ id: action.id });

          input = {
            type: "internal.promise",
            state: "pending",
            mode: action.mode,
            id: action.id,
          };
        } else {
          input = this.completedPromise(action.id, res.value);
        }
        continue;
      }

      // Handle die
      if (action.type === "internal.die") {
        if (action.condition) {
          action.error.log(this.verbose);
          return { kind: "error", error: action.error };
        }
        input = { type: "internal.nothing" };
        continue;
      }

      // Handle await on a completed promise (fast-path / replay)
      if (action.type === "internal.await" && action.promise.state === "completed") {
        util.assert(
          action.promise.value.type === "internal.literal",
          "promise value must be an 'internal.literal' type",
        );
        util.assertDefined(action.promise.value);
        input = action.promise.value;
        continue;
      }

      // Handle await on a pending promise
      if (action.type === "internal.await" && action.promise.state === "pending") {
        if (action.promise.mode === "detached") {
          // User is explicitly awaiting a detached promise — add its remote todo now
          remote.push({ id: action.id });
        }

        const localEntry = localWork.get(action.id);

        if (localEntry) {
          // This is a local in-flight task — await it inline
          localWork.delete(action.id);
          const result = await localEntry.promise;

          if (result.kind === "error") {
            result.error.log(this.verbose);
            return result;
          }

          const localResult = result.value;

          if (localResult.type === "done") {
            const settleRes = await this.settle(action.id, localResult.result, localEntry.funcName);

            if (settleRes.kind === "error") {
              settleRes.error.log(this.verbose);
              return settleRes;
            }

            util.assert(settleRes.value.state !== "pending", "promise must be completed");

            // Feed the resolved/rejected value directly as a Literal so the generator continues
            input = {
              type: "internal.literal",
              value: localResult.result,
            };
            continue;
          }

          // localResult.type === "suspended": child generator has remote deps
          // Flush remaining local work and collect all remote todos
          const res = await this.flushLocalWork(localWork);
          if (res.kind === "error") return res;

          const allRemote = [...remote, ...localResult.todo.remote, ...res.value.remote];
          return { kind: "value", value: { type: "suspended", todo: { remote: allRemote } } };
        }

        // Not in localWork — it's a remote pending promise.
        // Flush any in-flight local work so their remote dependencies are surfaced
        // and their completed durable promises are settled. Without this, eagerly
        // started local tasks would be silently abandoned, causing a deadlock when
        // the parent resumes and finds their durable promises still pending with no
        // task record to drive them.
        const flushResult = await this.flushLocalWork(localWork);
        if (flushResult.kind === "error") return flushResult;

        const allRemote = [...remote, ...flushResult.value.remote];
        return { kind: "value", value: { type: "suspended", todo: { remote: allRemote } } };
      }

      // Handle return
      if (action.type === "internal.return") {
        util.assert(action.value.type === "internal.literal", "promise value must be an 'internal.literal' type");
        util.assertDefined(action.value);

        // Structured concurrency: flush all in-flight local work before completing
        if (localWork.size > 0) {
          const flushResult = await this.flushLocalWork(localWork);
          if (flushResult.kind === "error") return flushResult;

          const allRemote = [...remote, ...flushResult.value.remote];
          if (allRemote.length > 0) {
            return { kind: "value", value: { type: "suspended", todo: { remote: allRemote } } };
          }
          return { kind: "value", value: { type: "done", result: action.value.value } };
        }

        if (remote.length > 0) {
          return { kind: "value", value: { type: "suspended", todo: { remote } } };
        }
        return { kind: "value", value: { type: "done", result: action.value.value } };
      }
    }
  }

  /**
   * Awaits all in-flight local work entries, settles completed durable promises,
   * and collects remote todos from any suspended child generators.
   */
  private async flushLocalWork(localWork: Map<string, LocalWorkEntry>): Promise<Result<{ remote: RemoteTodo[] }, any>> {
    const entries = [...localWork.entries()];
    localWork.clear();

    // Await all in-flight promises concurrently before checking results
    const results = await Promise.all(
      entries.map(async ([id, { funcName, promise }]) => ({ id, funcName, result: await promise })),
    );

    const allRemote: RemoteTodo[] = [];

    for (const { id, funcName, result } of results) {
      if (result.kind === "error") {
        result.error.log(this.verbose);
        return result;
      }

      const localResult = result.value;

      if (localResult.type === "suspended") {
        // Child generator has remote deps, collect them; its durable promise remains pending
        allRemote.push(...localResult.todo.remote);
      } else {
        // Child completed (success or user error), settle its durable promise
        const settleRes = await this.settle(id, localResult.result, funcName);

        if (settleRes.kind === "error") {
          settleRes.error.log(this.verbose);
          return settleRes;
        }
      }
    }

    return { kind: "value", value: { remote: allRemote } };
  }

  private settle(id: string, result: Result<any, any>, funcName: string) {
    return this.effects.promiseSettle(
      {
        kind: "promise.settle",
        head: { corrId: "", version: "" },
        data: {
          id,
          state: result.kind === "value" ? "resolved" : "rejected",
          value: {
            headers: {},
            data: result.kind === "value" ? result.value : result.error,
          },
        },
      },
      funcName,
    );
  }

  private completedPromise(id: string, record: PromiseRecord): PromiseCompleted<any> {
    return {
      type: "internal.promise",
      state: "completed",
      id,
      value: {
        type: "internal.literal",
        value:
          record.state === "resolved"
            ? { kind: "value", value: record.value?.data }
            : { kind: "error", error: record.value?.data },
      },
    };
  }
}
