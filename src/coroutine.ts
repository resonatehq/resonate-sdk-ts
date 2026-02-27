import type { Context, InnerContext } from "./context.js";
import { Decorator, type Value } from "./decorator.js";
import { Never } from "./retries.js";
import { traceEvent } from "./trace.js";
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
  private readonly depth: number;
  private readonly queueMicrotaskEveryN: number = 1;

  constructor(ctx: InnerContext, verbose: boolean, decorator: Decorator<T>, effects: Effects, depth = 1) {
    this.ctx = ctx;
    this.verbose = verbose;
    this.decorator = decorator;
    this.effects = effects;
    this.depth = depth;

    if (!(this.ctx.retryPolicy instanceof Never) && !logged.has(this.ctx.id)) {
      console.warn(`Options. Generator function '${this.ctx.func}' does not support retries. Will ignore.`);
      logged.set(this.ctx.id, true);
    }

    if (typeof process !== "undefined" && process.env.QUEUE_MICROTASK_EVERY_N) {
      this.queueMicrotaskEveryN = Number.parseInt(process.env.QUEUE_MICROTASK_EVERY_N, 10);
    }
  }

  public static exec(
    verbose: boolean,
    ctx: InnerContext,
    func: (ctx: Context, ...args: any[]) => Generator<Yieldable, any, any>,
    args: any[],
    effects: Effects,
    callback: (res: Result<Suspended | Done, any>) => void,
  ): void {
    const coroutine = new Coroutine(ctx, verbose, new Decorator(func(ctx, ...args)), effects);
    coroutine.exec((res) => {
      if (res.kind === "error") return callback(res);
      const status = res.value;
      switch (status.type) {
        case "more":
          callback({ kind: "value", value: { type: "suspended", todo: status.todo } });
          break;

        case "done":
          // Propagate raw result, no promise.settle. task.fulfill handles it.
          callback({ kind: "value", value: status });
          break;
      }
    });
  }

  private exec(callback: (res: Result<More | Done, any>) => void) {
    const local: LocalTodo[] = [];
    const remote: RemoteTodo[] = [];
    const remoteIds = new Set<string>();

    let input: Value<any> = {
      type: "internal.nothing",
    };

    // next needs to be called when we want to go to the top of the loop but are inside a callback
    const next = () => {
      while (true) {
        const action = this.decorator.next(input);

        // Handle internal.async.l (lfi/lfc)
        if (action.type === "internal.async.l") {
          traceEvent("async", this.ctx.func, action.id);
          this.effects.promiseCreate(
            action.createReq,
            (res) => {
              if (res.kind === "error") {
                res.error.log(this.verbose);
                return callback({ kind: "error", error: undefined });
              }
              util.assertDefined(res);

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
                  next(); // Go back to the top of the loop
                  return;
                }

                const coroutine = new Coroutine(
                  ctx,
                  this.verbose,
                  new Decorator(action.func(ctx, ...action.args)),
                  this.effects,
                  this.depth + 1,
                );

                const cb = (res: Result<More | Done, any>) => {
                  if (res.kind === "error") {
                    return callback(res);
                  }
                  const status = res.value;

                  if (status.type === "more") {
                    local.push(...status.todo.local);
                    remote.push(...status.todo.remote);
                    input = {
                      type: "internal.promise",
                      state: "pending",
                      mode: "attached",
                      id: action.id,
                    };
                    next();
                  } else {
                    this.effects.promiseSettle(
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
                      (res) => {
                        if (res.kind === "error") {
                          res.error.log(this.verbose);
                          return callback({ kind: "error", error: undefined });
                        }
                        util.assert(res.value.state !== "pending", "promise must be completed");

                        input = {
                          type: "internal.promise",
                          state: "completed",
                          id: action.id,
                          value: {
                            type: "internal.literal",
                            value:
                              res.value.state === "resolved"
                                ? { kind: "value", value: res.value.value?.data }
                                : { kind: "error", error: res.value.value?.data },
                          },
                        };
                        next();
                      },
                      action.func.name,
                    );
                  }
                };

                // Every nth level we kick off the next coroutine in a
                // microtask, escaping the current call stack. This is
                // necessary to avoid exceeding the maximum call stack
                // when the user program has adequate recursion.
                //
                // The microtask queue is exhausted before the
                // javascript engine moves on to macrotasks and a
                // coroutine may spawn recursive coroutines, opening up
                // the possibility of blocking the event loop
                // indefinitely. However, this is analagous to writing
                // a program with unbounded recursion, something that
                // is always possible.
                //
                // Experimenting with the queueMicrotaskEveryN value
                // shows that a value of 1 (our default) is optimal.
                traceEvent("spawn", action.func.name, action.id);
                if (this.depth % this.queueMicrotaskEveryN === 0) {
                  queueMicrotask(() => coroutine.exec(cb));
                } else {
                  coroutine.exec(cb);
                }
              } else {
                // durable promise is completed
                traceEvent("dedup", action.func.name, action.id);
                input = {
                  type: "internal.promise",
                  state: "completed",
                  id: action.id,
                  value: {
                    type: "internal.literal",
                    value:
                      res.value.state === "resolved"
                        ? { kind: "value", value: res.value.value?.data }
                        : { kind: "error", error: res.value.value?.data },
                  },
                };
                next();
              }
            },
            action.func.name,
          );
          return; // Exit the while loop to wait for async callback
        }

        // Handle internal.async.r
        if (action.type === "internal.async.r") {
          traceEvent("async", this.ctx.func, action.id);
          this.effects.promiseCreate(
            action.createReq,
            (res) => {
              if (res.kind === "error") {
                res.error.log(this.verbose);
                return callback({ kind: "error", error: undefined });
              }

              util.assertDefined(res);

              if (res.value.state === "pending") {
                if (action.mode === "attached") remote.push({ id: action.id });
                remoteIds.add(action.id);

                input = {
                  type: "internal.promise",
                  state: "pending",
                  mode: action.mode,
                  id: action.id,
                };
              } else {
                traceEvent("dedup", action.func, action.id);
                input = {
                  type: "internal.promise",
                  state: "completed",
                  id: action.id,
                  value: {
                    type: "internal.literal",
                    value:
                      res.value.state === "resolved"
                        ? { kind: "value", value: res.value.value?.data }
                        : { kind: "error", error: res.value.value?.data },
                  },
                };
              }
              next();
            },
            "unknown",
          );
          return; // Exit the while loop to wait for async callback
        }

        // Handle die
        if (action.type === "internal.die" && !action.condition) {
          input = {
            type: "internal.nothing",
          };
          continue;
        }

        if (action.type === "internal.die" && action.condition) {
          action.error.log(this.verbose);
          return callback({ kind: "error", error: undefined });
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
          traceEvent("await", this.ctx.func, action.id);
          if (remoteIds.has(action.id) || action.promise.mode === "detached") {
            traceEvent("block", this.ctx.func, action.id);
          }
          if (action.promise.mode === "detached") {
            // We didn't add the associated todo of this promise, since the user is explicitly awaiting it we need to add the todo now.
            // All detached are remotes.
            remote.push({ id: action.id });
          }
          callback({ kind: "value", value: { type: "more", todo: { local, remote } } });
          return;
        }

        // Handle return
        if (action.type === "internal.return") {
          traceEvent("return", this.ctx.func, this.ctx.id);
          util.assert(action.value.type === "internal.literal", "promise value must be an 'internal.literal' type");
          util.assertDefined(action.value);
          callback({ kind: "value", value: { type: "done", result: action.value.value } });
          return;
        }
      }
    };

    next();
  }
}
