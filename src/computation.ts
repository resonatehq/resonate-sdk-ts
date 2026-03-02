import type { Clock } from "./clock.js";
import { InnerContext } from "./context.js";
import type { ClaimedTask } from "./core.js";
import { Coroutine, type LocalTodo } from "./coroutine.js";
import exceptions from "./exceptions.js";
import type { Heartbeat } from "./heartbeat.js";
import type { PromiseRecord } from "./network/types.js";
import type { OptionsBuilder } from "./options.js";
import { AsyncProcessor, type Processor } from "./processor/processor.js";
import type { Registry } from "./registry.js";
import { Exponential, Never, type RetryPolicyConstructor } from "./retries.js";
import type { Effects, Func, Result } from "./types.js";
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
  private processing = false;

  constructor(
    id: string,
    clock: Clock,
    effects: Effects,
    retries: Map<string, RetryPolicyConstructor>,
    registry: Registry,
    heartbeat: Heartbeat,
    dependencies: Map<string, any>,
    optsBuilder: OptionsBuilder,
    verbose: boolean,
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
  }

  public async executeUntilBlocked(task: ClaimedTask): Promise<Result<Status, undefined>> {
    // If we are already processing there is nothing to do, the
    // caller will be notified via the promise handler
    if (this.processing) return { kind: "error", error: undefined };

    this.processing = true;
    const result = await this.processAcquired(task);
    this.processing = false;
    return result;
  }

  private async processAcquired({ rootPromise }: ClaimedTask): Promise<Result<Status, undefined>> {
    if (!isValidData(rootPromise.param?.data)) {
      return { kind: "error", error: undefined };
    }

    const { func, args, retry, version = 1 } = rootPromise.param.data;
    const registered = this.registry.get(func, version);

    // function must be registered
    if (!registered) {
      exceptions.REGISTRY_FUNCTION_NOT_REGISTERED(func, version).log(this.verbose);
      return { kind: "error", error: undefined };
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
    };

    if (util.isGeneratorFunction(registered.func)) {
      return this.processGenerator(registered.func, ctxConfig, args, rootPromise);
    }

    return this.processFunction(this.id, registered.func, new InnerContext(ctxConfig), args);
  }

  private async processGenerator(
    func: Func,
    ctxConfig: ConstructorParameters<typeof InnerContext>[0],
    args: any[],
    rootPromise: PromiseRecord,
  ): Promise<Result<Status, undefined>> {
    while (true) {
      // If boundary promise is done, short-circuit
      if (rootPromise.state !== "pending") {
        return {
          kind: "value",
          value: {
            kind: "done",
            id: rootPromise.id,
            state: rootPromise.state === "resolved" ? "resolved" : "rejected",
            value: rootPromise.value,
          },
        };
      }

      const ctx = new InnerContext(ctxConfig);
      const res = await Coroutine.exec(this.verbose, ctx, func, args, this.effects);

      if (res.kind === "error") {
        return { kind: "error", error: undefined };
      }

      const status = res.value;

      if (status.type === "done") {
        return {
          kind: "value",
          value: {
            kind: "done",
            id: this.id,
            state: status.result.kind === "value" ? "resolved" : "rejected",
            value: status.result.kind === "value" ? status.result.value : status.result.error,
          },
        };
      }

      // status.type === "suspended"
      util.assert(status.todo.local.length > 0 || status.todo.remote.length > 0, "must be at least one todo");

      if (status.todo.local.length > 0) {
        const localRes = await this.processLocalTodo(status.todo.local);
        if (localRes.kind === "error") {
          return localRes;
        }
        // Loop back to re-execute the generator
        continue;
      }

      // Only remote todos
      return { kind: "value", value: { kind: "suspended", awaited: status.todo.remote.map((t) => t.id) } };
    }
  }

  private async processFunction(
    id: string,
    func: Func,
    ctx: InnerContext,
    args: any[],
  ): Promise<Result<Status, undefined>> {
    this.processor.process([
      {
        id,
        ctx,
        func: async () => await func(ctx, ...args),
        verbose: this.verbose,
      },
    ]);

    const results = await this.processor.getReady([id]);
    util.assert(results.length === 1, "getReady must return exactly one result");

    const { result } = results[0];

    return {
      kind: "value",
      value: {
        kind: "done",
        id,
        state: result.kind === "value" ? "resolved" : "rejected",
        value: result.kind === "value" ? result.value : result.error,
      },
    };
  }

  private async processLocalTodo(todo: LocalTodo[]): Promise<Result<undefined, undefined>> {
    const work = todo.map((t) => ({
      id: t.id,
      ctx: t.ctx,
      func: async () => await t.func(t.ctx, ...t.args),
      verbose: this.verbose,
    }));

    this.processor.process(work);

    const ids = todo.map((t) => t.id);
    const results = await this.processor.getReady(ids);
    util.assert(results.length > 0, "getReady must return results");

    // Intentionally waits for all settlements before checking errors.
    // This ensures all in-flight settle requests complete before returning,
    // rather than re-entering the generator on partial errors.
    const settleResults = await Promise.allSettled(
      results.map(({ id, result: res }) =>
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
          id,
        ),
      ),
    );

    for (const settleResult of settleResults) {
      if (settleResult.status === "rejected") {
        return { kind: "error", error: undefined };
      }
      const settleRes = settleResult.value;
      if (settleRes.kind === "error") {
        settleRes.error.log(this.verbose);
        return { kind: "error", error: undefined };
      }
    }

    return { kind: "value", value: undefined };
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
