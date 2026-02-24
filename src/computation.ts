import type { Clock } from "./clock.js";
import { InnerContext } from "./context.js";
import type { ClaimedTask, Task } from "./core.js";
import { Coroutine, type LocalTodo } from "./coroutine.js";
import type { Effects } from "./effects.js";
import exceptions from "./exceptions.js";
import type { Heartbeat } from "./heartbeat.js";
import type { Network } from "./network/network.js";
import type { PromiseRecord, TaskRecord } from "./network/types.js";
import type { OptionsBuilder } from "./options.js";
import { AsyncProcessor, type Processor } from "./processor/processor.js";
import type { Registry } from "./registry.js";
import { Exponential, Never, type RetryPolicyConstructor } from "./retries.js";
import type { Span, Tracer } from "./tracer.js";
import type { Func, Result } from "./types.js";
import * as util from "./util.js";

export type Status = Done | Suspended;

export type Done = {
  kind: "done";
  id: string;
  state: "resolved" | "rejected";
  value: any;
};

export type Suspended = {
  kind: "suspended";
  awaited: string[];
};

interface Data {
  func: string;
  args: any[];
  retry?: { type: string; data: any };
  version?: number;
}

export class Computation {
  private id: string;
  private clock: Clock;
  private effects: Effects;
  private retries: Map<string, RetryPolicyConstructor>;
  private registry: Registry;
  private dependencies: Map<string, any>;
  private optsBuilder: OptionsBuilder;
  private verbose: boolean;
  private heartbeat: Heartbeat;
  private processor: Processor;
  private span: Span;
  private spans: Map<string, Span>;

  private seen: Set<string> = new Set();
  private processing = false;

  constructor(
    id: string,
    clock: Clock,
    network: Network,
    effects: Effects,
    retries: Map<string, RetryPolicyConstructor>,
    registry: Registry,
    heartbeat: Heartbeat,
    dependencies: Map<string, any>,
    optsBuilder: OptionsBuilder,
    verbose: boolean,
    tracer: Tracer,
    span: Span,
    processor?: Processor,
  ) {
    this.id = id;
    this.clock = clock;
    this.effects = effects;
    this.retries = retries;
    this.registry = registry;
    this.heartbeat = heartbeat;
    this.dependencies = dependencies;
    this.optsBuilder = optsBuilder;
    this.verbose = verbose;
    this.processor = processor ?? new AsyncProcessor();
    this.span = span;
    this.spans = new Map();
  }

  public executeUntilBlocked(task: Task, done: (res: Result<Status, undefined>) => void) {
    // If we are already processing there is nothing to do, the
    // caller will be notified via the promise handler
    if (this.processing) return done({ kind: "error", error: undefined });
    this.processing = true;

    const doneProcessing = (res: Result<Status, undefined>) => {
      this.processing = false;
      done(res);
    };

    switch (task.kind) {
      case "claimed":
        this.processAcquired(task, doneProcessing);
        break;

      case "unclaimed":
        util.assert(false, "All tasks must be claimed at this point");
        break;
    }
  }

  private processAcquired({ task, rootPromise }: ClaimedTask, done: (res: Result<Status, undefined>) => void) {
    if (!isValidData(rootPromise.param?.data)) {
      return done({ kind: "error", error: undefined });
    }

    const { func, args, retry, version = 1 } = rootPromise.param.data;
    const registered = this.registry.get(func, version);

    // function must be registered
    if (!registered) {
      exceptions.REGISTRY_FUNCTION_NOT_REGISTERED(func, version).log(this.verbose);
      return done({ kind: "error", error: undefined });
    }

    if (version !== 0) util.assert(version === registered.version, "versions must match");
    util.assert(func === registered.name, "names must match");

    // start heartbeat
    this.heartbeat.start();

    const retryCtor = retry ? this.retries.get(retry.type) : undefined;
    const retryPolicy = retryCtor
      ? new retryCtor(retry?.data)
      : util.isGeneratorFunction(registered.func)
        ? new Never()
        : new Exponential();

    if (retry && !retryCtor) {
      console.warn(`Options. Retry policy '${retry.type}' not found. Will ignore.`);
    }

    const ctxConfig = {
      id: this.id,
      oId: rootPromise.tags["resonate:origin"] ?? this.id,
      func: registered.func.name,
      clock: this.clock,
      registry: this.registry,
      dependencies: this.dependencies,
      optsBuilder: this.optsBuilder,
      timeout: rootPromise.timeoutAt,
      version: registered.version,
      retryPolicy: retryPolicy,
      span: this.span,
    };

    if (util.isGeneratorFunction(registered.func)) {
      this.processGenerator(ctxConfig, registered.func, args, task, rootPromise, done);
    } else {
      this.processFunction(this.id, new InnerContext(ctxConfig), registered.func, args, (res) => {
        if (res.kind === "error") return done({ kind: "error", error: undefined });

        const result = res.value;
        util.assert(result.kind === "done", "Status must be done after finishing function execution");
        done({
          kind: "value",
          value: {
            kind: "done",
            id: this.id,
            state: result.state,
            value: result.value,
          },
        });
      });
    }
  }

  private processGenerator(
    ctxConfig: ConstructorParameters<typeof InnerContext>[0],
    func: Func,
    args: any[],
    task: TaskRecord,
    rootPromise: PromiseRecord,
    done: (res: Result<Status, undefined>) => void,
  ) {
    // If boundary promise is done, short-circuit
    if (rootPromise.state !== "pending") {
      done({
        kind: "value",
        value: {
          kind: "done",
          id: rootPromise.id,
          state: rootPromise.state === "resolved" ? "resolved" : "rejected",
          value: rootPromise.value,
        },
      });
    }

    const ctx = new InnerContext(ctxConfig);

    Coroutine.exec(this.id, this.verbose, ctx, func, args, task, this.effects, this.spans, (res) => {
      if (res.kind === "error") {
        return done(res);
      }
      const status = res.value;

      switch (status.type) {
        case "done":
          done({
            kind: "value",
            value: {
              kind: "done",
              id: this.id,
              state: status.result.kind === "value" ? "resolved" : "rejected",
              value: status.result.kind === "value" ? status.result.value : status.result.error,
            },
          });
          break;

        case "suspended":
          util.assert(status.todo.local.length > 0 || status.todo.remote.length > 0, "must be at least one todo");
          if (status.todo.local.length > 0) {
            return this.processLocalTodo(
              status.todo.local,
              util.once(() => this.processGenerator(ctxConfig, func, args, task, rootPromise, done)),
              (err) => done({ kind: "error", error: undefined }),
            );
          } else if (status.todo.remote.length > 0) {
            done({ kind: "value", value: { kind: "suspended", awaited: status.todo.remote.map((t) => t.id) } });
          }
          break;
      }
    });
  }

  private processFunction(
    id: string,
    ctx: InnerContext,
    func: Func,
    args: any[],
    done: (res: Result<Status, undefined>) => void,
  ) {
    this.processor.process([
      {
        id,
        ctx,
        func: async () => await func(ctx, ...args),
        span: ctx.span,
        verbose: this.verbose,
      },
    ]);

    this.processor.getReady([id], (results) => {
      util.assert(results.length === 1, "getReady must return one result");
      const result = results[0];
      const { result: res } = result;

      done({
        kind: "value",
        value: {
          kind: "done",
          id: this.id,
          state: res.kind === "value" ? "resolved" : "rejected",
          value: res.kind === "value" ? res.value : res.error,
        },
      });
    });
  }

  private processLocalTodo(todo: LocalTodo[], cb: () => void, onErr: (err: any) => void) {
    const work = todo.map((t) => ({
      id: t.id,
      ctx: t.ctx,
      func: async () => await t.func(t.ctx, ...t.args),
      span: t.ctx.span,
      verbose: this.verbose,
    }));

    this.processor.process(work);

    // Get at least the first result that is ready and settle promises
    const ids = todo.map((t) => t.id);
    this.processor.getReady(ids, (results) => {
      util.assert(results.length > 0, "getReady must return results");
      let settledCount = 0;
      for (const result of results) {
        const { id, result: res } = result;
        this.effects.promiseSettle(
          {
            kind: "promise.settle",
            head: { corrId: "", version: "" },
            data: {
              id: id,
              state: res.kind === "value" ? "resolved" : "rejected",
              value: {
                data: res.kind === "value" ? res.value : res.error,
                headers: {},
              },
            },
          },
          (settleRes) => {
            if (settleRes.kind === "error") {
              settleRes.error.log(this.verbose);
              onErr(settleRes.error);
            }

            settledCount++;
            if (settledCount === results.length) {
              cb();
            }
          },
          id,
        );
      }
    });
  }
}

// Helper functions

function isValidData(data: unknown): data is Data {
  if (data === null || typeof data !== "object") return false;

  const d = data as any;

  // func must be a string
  if (typeof d.func !== "string") return false;

  // args must be an array
  if (!Array.isArray(d.args)) return false;

  // retry (if present) must be an object with string `type` and any `data`
  if (d.retry !== undefined) {
    if (d.retry === null || typeof d.retry !== "object" || typeof d.retry.type !== "string" || !("data" in d.retry)) {
      return false;
    }
  }

  // version (if present) must be a number
  if (d.version !== undefined && typeof d.version !== "number") {
    return false;
  }

  return true;
}
