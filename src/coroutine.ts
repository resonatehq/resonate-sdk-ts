import type { Context, InnerContext } from "./context.js";
import { Decorator, type PromiseCompleted, type Value } from "./decorator.js";
import type { PromiseRecord } from "./network/types.js";
import { Never } from "./retries.js";
import type { Effects, Result, Yieldable } from "./types.js";
import * as util from "./util.js";

export type Suspended = {
  type: "suspended";
  todo: { local: LocalTodo[]; remote: RemoteTodo[] };
};

export interface LocalTodo {
  id: string;
  ctx: InnerContext;
  func: (ctx: Context, ...args: any[]) => any;
  args: any[];
}

export interface RemoteTodo {
  id: string;
}

type More = {
  type: "more";
  todo: { local: LocalTodo[]; remote: RemoteTodo[] };
};

export type Done = {
  type: "done";
  result: Result<any, any>;
};

// a simple map to suppress duplicate warnings, necessary due to
// micro retries
const logged: Map<string, boolean> = new Map();

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
    const res = await coroutine.exec();
    if (res.kind === "error") {
      return res;
    }
    if (res.value.type === "more") {
      return { kind: "value", value: { type: "suspended", todo: res.value.todo } };
    }
    return { kind: "value", value: res.value };
  }

  private async exec(): Promise<Result<More | Done, any>> {
    const local: LocalTodo[] = [];
    const remote: RemoteTodo[] = [];

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
          if (!util.isGeneratorFunction(action.func)) {
            local.push({
              id: action.id,
              ctx,
              func: action.func,
              args: action.args,
            });
            input = {
              type: "internal.promise",
              state: "pending",
              mode: "attached",
              id: action.id,
            };
            continue;
          }

          const coroutine = new Coroutine(
            ctx,
            this.verbose,
            new Decorator(action.func(ctx, ...action.args)),
            this.effects,
          );

          const statusRes = await coroutine.exec();

          if (statusRes.kind === "error") {
            statusRes.error.log(this.verbose);
            return statusRes;
          }

          const status = statusRes.value;

          if (status.type === "more") {
            local.push(...status.todo.local);
            remote.push(...status.todo.remote);
            input = {
              type: "internal.promise",
              state: "pending",
              mode: "attached",
              id: action.id,
            };
          } else {
            const settleRes = await this.effects.promiseSettle(
              {
                kind: "promise.settle",
                head: { corrId: "", version: "" },
                data: {
                  id: action.id,
                  state: status.result.kind === "value" ? "resolved" : "rejected",
                  value: {
                    headers: {},
                    data: status.result.kind === "value" ? status.result.value : status.result.error,
                  },
                },
              },
              action.func.name,
            );

            if (settleRes.kind === "error") {
              settleRes.error.log(this.verbose);
              return settleRes;
            }

            util.assert(settleRes.value.state !== "pending", "promise must be completed");

            input = this.completedPromise(action.id, settleRes.value);
          }
        } else {
          // durable promise is completed
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

      // Handle await
      if (action.type === "internal.await" && action.promise.state === "completed") {
        util.assert(
          action.promise.value.type === "internal.literal",
          "promise value must be an 'internal.literal' type",
        );
        util.assertDefined(action.promise.value);
        input = action.promise.value;
        continue;
      }

      // invoke the callback when awaiting a pending "Future" the list of todos will include
      // the global callbacks to create.
      if (action.type === "internal.await" && action.promise.state === "pending") {
        if (action.promise.mode === "detached") {
          // We didn't add the associated todo of this promise, since the user is explicitly awaiting it we need to add the todo now.
          // All detached are remotes.
          remote.push({ id: action.id });
        }
        return { kind: "value", value: { type: "more", todo: { local, remote } } };
      }

      // Handle return
      if (action.type === "internal.return") {
        util.assert(action.value.type === "internal.literal", "promise value must be an 'internal.literal' type");
        util.assertDefined(action.value);
        return { kind: "value", value: { type: "done", result: action.value.value } };
      }
    }
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
