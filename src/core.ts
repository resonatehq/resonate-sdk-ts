import type { Clock } from "./clock.js";
import { Computation, type Status } from "./computation.js";
import type { Handler } from "./handler.js";
import type { Heartbeat } from "./heartbeat.js";
import type { MessageSource, Network } from "./network/network.js";
import type { Msg, PromiseRecord, TaskRecord } from "./network/types.js";
import type { OptionsBuilder } from "./options.js";
import type { Registry } from "./registry.js";
import { Constant, Exponential, Linear, Never, type RetryPolicyConstructor } from "./retries.js";
import type { Span, Tracer } from "./tracer.js";
import type { Result } from "./types.js";
import * as util from "./util.js";

export type PromiseHandler = {
  addEventListener: (event: "created" | "completed", callback: (p: PromiseRecord) => void) => void;
  subscribe: () => Promise<void>;
};

export type Task = ClaimedTask | UnclaimedTask;

export type ClaimedTask = {
  kind: "claimed";
  task: TaskRecord;
  rootPromise: PromiseRecord;
};

export type UnclaimedTask = {
  kind: "unclaimed";
  task: TaskRecord;
};

export class Core {
  private unicast: string;
  private anycast: string;
  private pid: string;
  private ttl: number;
  private clock: Clock;
  private network: Network;
  private handler: Handler;
  private tracer: Tracer;
  private retries: Map<string, RetryPolicyConstructor>;
  private registry: Registry;
  private heartbeat: Heartbeat;
  private dependencies: Map<string, any>;
  private optsBuilder: OptionsBuilder;
  private verbose: boolean;
  private computations: Map<string, Computation> = new Map();

  constructor({
    unicast,
    anycast,
    pid,
    ttl,
    clock,
    network,
    handler,
    tracer,
    registry,
    heartbeat,
    dependencies,
    optsBuilder,
    verbose,
    messageSource = undefined,
  }: {
    unicast: string;
    anycast: string;
    pid: string;
    ttl: number;
    clock: Clock;
    network: Network;
    handler: Handler;
    tracer: Tracer;
    registry: Registry;
    heartbeat: Heartbeat;
    dependencies: Map<string, any>;
    optsBuilder: OptionsBuilder;
    verbose: boolean;
    messageSource?: MessageSource;
  }) {
    this.unicast = unicast;
    this.anycast = anycast;
    this.pid = pid;
    this.ttl = ttl;
    this.clock = clock;
    this.network = network;
    this.handler = handler;
    this.tracer = tracer;
    this.registry = registry;
    this.heartbeat = heartbeat;
    this.dependencies = dependencies;
    this.optsBuilder = optsBuilder;
    this.verbose = verbose;

    // default retry policies
    this.retries = new Map<string, RetryPolicyConstructor>([
      [Constant.type, Constant],
      [Exponential.type, Exponential],
      [Linear.type, Linear],
      [Never.type, Never],
    ]);

    // subscribe to execute
    messageSource?.subscribe("execute", (msg) => {
      this.onMessage.bind(this)(msg, () => {});
    });
  }

  public executeUntilBlocked(span: Span, claimed: ClaimedTask, done: (res: Result<Status, undefined>) => void) {
    console.log("running", claimed);
    let computation = this.computations.get(claimed.rootPromise.id);
    if (!computation) {
      computation = new Computation(
        claimed.rootPromise.id,
        this.clock,
        this.network,
        this.handler,
        this.retries,
        this.registry,
        this.heartbeat,
        this.dependencies,
        this.optsBuilder,
        this.verbose,
        this.tracer,
        span,
      );
      this.computations.set(claimed.rootPromise.id, computation);
    }

    computation.executeUntilBlocked(claimed, (compRes) => {
      console.log("compRes", compRes);
      if (compRes.kind === "error") {
        return this.releaseTask(claimed.task, () => done(compRes));
      }
      if (compRes.kind === "value") {
        const status = compRes.value;
        if (status.kind === "suspended") {
          return this.suspendTask(claimed, status, (res: Result<{ continue: boolean }, undefined>) => {
            if (res.kind === "value") {
              if (res.value.continue) {
                return this.executeUntilBlocked(span, claimed, done);
              }
              return done(compRes);
            }
          });
        }
        if (status.kind === "done") {
          console.log("value for task.fulfil", status.value);
          return this.fulfillTask(claimed.task, status, () => done(compRes));
        }
      }
    });
  }

  private releaseTask(task: TaskRecord, callback: () => void): void {
    this.network.send(
      {
        kind: "task.release",
        head: { corrId: "", version: "" },
        data: { id: task.id, version: task.version },
      },
      callback,
    );
  }

  private suspendTask(
    claimed: ClaimedTask,
    status: { kind: "suspended"; awaited: string[] },
    cb: (res: Result<{ continue: boolean }, undefined>) => void,
  ): void {
    const task = claimed.task;
    this.handler.taskSuspend(
      {
        kind: "task.suspend",
        head: { corrId: "", version: "" },
        data: {
          id: task.id,
          version: task.version,
          actions: status.awaited.map((a) => ({
            kind: "promise.register",
            head: { corrId: "", version: "" },
            data: { awaiter: claimed.rootPromise.id, awaited: a },
          })),
        },
      },
      (res) => {
        if (res.kind === "error") {
          res.error.log(this.verbose);
          return cb({ kind: "error", error: undefined });
        } else if (res.kind === "value") {
          return cb(res);
        }
      },
    );
  }

  private fulfillTask(
    task: TaskRecord,
    doneValue: { id: string; state: "resolved" | "rejected"; value: any },
    callback: () => void,
  ): void {
    const encoded = this.handler.encodeValue(doneValue.value, "TODO, get function name");
    if (encoded.kind === "error") {
      encoded.error.log(this.verbose);
      callback();
      return;
    }

    this.network.send(
      {
        kind: "task.fulfill",
        head: { corrId: "", version: "" },
        data: {
          id: task.id,
          version: task.version,
          action: {
            kind: "promise.settle",
            head: { corrId: "", version: "" },
            data: {
              id: doneValue.id,
              state: doneValue.state,
              value: encoded.value,
            },
          },
        },
      },
      callback,
    );
  }

  public onMessage(msg: Msg, cb: () => void): void {
    util.assert(msg.kind === "execute");

    if (msg.kind === "execute") {
      // acquire the task and then execute until blocked
      const task = msg.data.task;
      this.handler.taskAcquire(
        {
          kind: "task.acquire",
          head: { corrId: "", version: "" },
          data: { id: task.id, version: task.version, pid: this.pid, ttl: this.ttl },
        },
        (res) => {
          if (res.kind === "error") {
            res.error.log(this.verbose);
          } else {
            this.executeUntilBlocked(
              this.tracer.decode(msg.head),
              { kind: "claimed", task: task, rootPromise: res.value.root },
              (_res) => {
                cb();
              },
            );
          }
        },
      );
    }
  }
}
