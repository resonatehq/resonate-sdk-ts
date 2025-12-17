import type { Clock } from "./clock";
import { InnerContext } from "./context";
import { Coroutine, type LocalTodo, type RemoteTodo } from "./coroutine";
import exceptions from "./exceptions";
import type { Handler } from "./handler";
import type { Heartbeat } from "./heartbeat";
import type { CallbackRecord, DurablePromiseRecord, Network, TaskRecord } from "./network/network";
import { Nursery } from "./nursery";
import type { OptionsBuilder } from "./options";
import { AsyncProcessor, type Processor } from "./processor/processor";
import type { Registry } from "./registry";
import type { ClaimedTask, Task } from "./resonate-inner";
import { Exponential, Never, type RetryPolicyConstructor } from "./retries";
import type { Span, Tracer } from "./tracer";
import * as types from "./types";
import * as util from "./util";

export type Status = Completed | Suspended;

export type Completed = {
  kind: "completed";
  promise: DurablePromiseRecord;
};

export type Suspended = {
  kind: "suspended";
  callbacks: CallbackRecord[];
};

interface Data {
  func: string;
  args: any[];
  retry?: { type: string; data: any };
  version?: number;
}

export class Computation {
  private id: string;
  private pid: string;
  private ttl: number;
  private clock: Clock;
  private unicast: string;
  private anycast: string;
  private network: Network;
  private handler: Handler;
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
    unicast: string,
    anycast: string,
    pid: string,
    ttl: number,
    clock: Clock,
    network: Network,
    handler: Handler,
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
    this.unicast = unicast;
    this.anycast = anycast;
    this.pid = pid;
    this.ttl = ttl;
    this.clock = clock;
    this.network = network;
    this.handler = handler;
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

  public process(task: Task, done: types.Callback<Status>) {
    // If we are already processing there is nothing to do, the
    // caller will be notified via the promise handler
    if (this.processing) return done(types.error("already processing"));
    this.processing = true;

    const doneProcessing = (res: types.Result<Status>) => {
      this.processing = false;
      res.tag !== "value" ? done(types.error("done processing")) : done(types.value(res.value));
    };

    switch (task.kind) {
      case "claimed":
        this.processClaimed(task, doneProcessing);
        break;

      case "unclaimed":
        this.handler.claimTask(
          {
            kind: "claimTask",
            id: task.task.id,
            counter: task.task.counter,
            processId: this.pid,
            ttl: this.ttl,
          },
          (err, promise) => {
            if (err) {
              err.log(this.verbose);
              return doneProcessing(types.error("oops!"));
            }
            util.assertDefined(promise);
            this.processClaimed(
              { kind: "claimed", task: task.task, rootPromise: promise.root, leafPromise: promise.leaf },
              doneProcessing,
            );
          },
        );
        break;
    }
  }

  private processClaimed({ task, rootPromise }: ClaimedTask, done: types.Callback<Status>) {
    util.assert(task.rootPromiseId === this.id, "task root promise id must match computation id");

    const doneAndDropTaskIfErr = (res: types.Result<Status>) => {
      if (res.tag !== "value") {
        return this.network.send({ kind: "dropTask", id: task.id, counter: task.counter }, () => {
          // ignore the drop task response, if the request failed the
          // task will eventually expire anyways
          done(types.error("couldn't drop task"));
        });
      }
      done(res);
    };

    if (!isValidData(rootPromise.param?.data)) {
      return doneAndDropTaskIfErr(types.fatal("invalid data"));
    }

    const { func, args, retry, version = 1 } = rootPromise.param.data;
    const registered = this.registry.get(func, version);

    // function must be registered
    if (!registered) {
      exceptions.REGISTRY_FUNCTION_NOT_REGISTERED(func, version).log(this.verbose);
      return doneAndDropTaskIfErr(types.fatal("function not registered"));
    }

    if (version !== 0) util.assert(version === registered.version, "versions must match");
    util.assert(func === registered.name, "names must match");

    // start heartbeat
    this.heartbeat.start();

    return new Nursery<boolean, Status>((nursery) => {
      const done = (res: types.Result<Status>) => {
        if (res.tag !== "value") {
          return nursery.done(res);
        }

        this.network.send({ kind: "completeTask", id: task.id, counter: task.counter }, (err) => {
          nursery.done(res);
        });
      };

      const retryCtor = retry ? this.retries.get(retry.type) : undefined;
      const retryPolicy = retryCtor
        ? new retryCtor(retry?.data)
        : util.isGeneratorFunction(registered.func)
          ? new Never()
          : new Exponential();

      if (retry && !retryCtor) {
        console.warn(`Options. Retry policy '${retry.type}' not found. Will ignore.`);
      }

      const ctx = new InnerContext({
        id: this.id,
        func: registered.func.name,
        clock: this.clock,
        registry: this.registry,
        dependencies: this.dependencies,
        optsBuilder: this.optsBuilder,
        timeout: rootPromise.timeout,
        version: registered.version,
        retryPolicy: retryPolicy,
        span: this.span,
      });

      if (util.isGeneratorFunction(registered.func)) {
        this.processGenerator(nursery, ctx, registered.func, args, task, done);
      } else {
        this.processFunction(this.id, ctx, registered.func, args, (res) => {
          if (res.tag !== "value") return done(res);

          done(types.value({ kind: "completed", promise: res.value }));
        });
      }
    }, doneAndDropTaskIfErr);
  }

  private processGenerator(
    nursery: Nursery<boolean, Status>,
    ctx: InnerContext,
    func: types.Func,
    args: any[],
    task: TaskRecord,
    done: types.Callback<Status>,
  ) {
    Coroutine.exec(this.id, this.verbose, ctx, func, args, task, this.handler, this.spans, (res) => {
      if (res.tag !== "value") {
        return done(res);
      }

      const status = res.value;

      switch (status.type) {
        case "completed":
          done(types.value({ kind: "completed", promise: status.promise }));
          break;

        case "suspended":
          util.assert(status.todo.local.length > 0 || status.todo.remote.length > 0, "must be at least one todo");

          if (status.todo.local.length > 0) {
            this.processLocalTodo(nursery, status.todo.local, done);
          } else if (status.todo.remote.length > 0) {
            this.processRemoteTodo(nursery, status.todo.remote, status.spans, ctx.info.timeout, done);
          }

          break;
      }
    });
  }

  private processFunction(
    id: string,
    ctx: InnerContext,
    func: types.Func,
    args: any[],
    done: types.Callback<DurablePromiseRecord>,
  ) {
    this.processor.process(
      id,
      ctx,
      async () => await func(ctx, ...args),
      (res) => {
        util.assert(res.tag !== "fatal");
        this.handler.completePromise(
          {
            kind: "completePromise",
            id: id,
            state: res.tag === "value" ? "resolved" : "rejected",
            value: {
              data: res.tag === "value" ? res.value : res.error,
            },
            iKey: id,
            strict: false,
          },
          (err, res) => {
            if (err) {
              err.log(this.verbose);
              return done(types.error("oops!"));
            }
            util.assertDefined(res);
            done(types.value(res));
          },
          func.name,
        );
      },
      this.verbose,
      ctx.span,
    );
  }

  private processLocalTodo(nursery: Nursery<boolean, Status>, todo: LocalTodo[], done: types.Callback<Status>) {
    for (const { id, ctx, span, func, args } of todo) {
      if (this.seen.has(id)) {
        continue;
      }

      this.seen.add(id);

      nursery.hold((next) => {
        this.processFunction(id, ctx, func, args, (res) => {
          span.end(this.clock.now());
          next();

          if (res.tag !== "value") {
            this.seen.delete(id);
            done(res);
          }
        });
      });
    }

    // once all local todos are submitted we can call continue
    return nursery.cont();
  }

  private processRemoteTodo(
    nursery: Nursery<boolean, Status>,
    todo: RemoteTodo[],
    spans: Span[],
    timeout: number,
    done: types.Callback<Status>,
  ) {
    nursery.all<
      RemoteTodo,
      { kind: "callback"; callback: CallbackRecord } | { kind: "promise"; promise: DurablePromiseRecord },
      boolean
    >(
      todo,
      ({ id }, done) =>
        this.handler.createCallback(
          {
            kind: "createCallback",
            promiseId: id,
            rootPromiseId: this.id,
            timeout: timeout,
            recv: this.anycast,
          },
          (err, res) => {
            if (err) {
              err.log(this.verbose);
              return done(true);
            }
            util.assertDefined(res);
            done(false, res);
          },
          this.span.encode(),
        ),
      (err, results) => {
        if (err) {
          for (const span of spans) {
            span.end(this.clock.now());
          }
          return done(types.error("oops!"));
        }
        util.assertDefined(results);

        const callbacks: CallbackRecord[] = [];

        for (const res of results) {
          switch (res.kind) {
            case "promise":
              nursery.hold((next) => next());
              return nursery.cont();

            case "callback":
              callbacks.push(res.callback);
              break;
          }
        }

        for (const span of spans) {
          span.end(this.clock.now());
        }

        // once all callbacks are created we can call done
        return done(types.value({ kind: "suspended", callbacks }));
      },
    );
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
