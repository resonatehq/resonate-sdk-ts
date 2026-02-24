import type { Clock } from "./clock.js";
import type { Codec } from "./codec.js";
import { Computation, type Done, type Status } from "./computation.js";
import exceptions from "./exceptions.js";
import type { Heartbeat } from "./heartbeat.js";
import type { MessageSource, Network } from "./network/network.js";
import {
  isRedirect,
  isSuccess,
  type Message,
  type PromiseRecord,
  type TaskRecord,
  type Value,
} from "./network/types.js";
import type { OptionsBuilder } from "./options.js";
import type { Registry } from "./registry.js";
import { Constant, Exponential, Linear, Never, type RetryPolicyConstructor } from "./retries.js";
import type { Span, Tracer } from "./tracer.js";
import type { Effects, Result } from "./types.js";
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
  private pid: string;
  private ttl: number;
  private clock: Clock;
  private network: Network;
  private codec: Codec;
  private tracer: Tracer;
  private retries: Map<string, RetryPolicyConstructor>;
  private registry: Registry;
  private heartbeat: Heartbeat;
  private dependencies: Map<string, any>;
  private optsBuilder: OptionsBuilder;
  private verbose: boolean;
  private computations: Map<string, Computation> = new Map();
  private effects: Effects;

  constructor({
    pid,
    ttl,
    clock,
    network,
    codec,
    tracer,
    registry,
    heartbeat,
    dependencies,
    optsBuilder,
    verbose,
    messageSource = undefined,
  }: {
    pid: string;
    ttl: number;
    clock: Clock;
    network: Network;
    codec: Codec;
    tracer: Tracer;
    registry: Registry;
    heartbeat: Heartbeat;
    dependencies: Map<string, any>;
    optsBuilder: OptionsBuilder;
    verbose: boolean;
    messageSource?: MessageSource;
  }) {
    this.pid = pid;
    this.ttl = ttl;
    this.clock = clock;
    this.network = network;
    this.codec = codec;
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

    this.effects = util.buildEffects(this.network, this.codec);

    // subscribe to execute
    messageSource?.subscribe("execute", (msg) => {
      this.onMessage(msg, () => undefined);
    });
  }

  public executeUntilBlocked(span: Span, claimed: ClaimedTask, done: (res: Result<Status, undefined>) => void) {
    let computation = this.computations.get(claimed.rootPromise.id);
    if (!computation) {
      computation = this.createComputation(claimed.rootPromise.id, span);
      this.computations.set(claimed.rootPromise.id, computation);
    }

    computation.executeUntilBlocked(claimed, (compRes) => {
      if (compRes.kind === "error") {
        return this.releaseTask(claimed.task, () => done(compRes));
      }
      if (compRes.kind === "value") {
        const status = compRes.value;
        if (status.kind === "suspended") {
          return this.suspendTask(claimed, status, (res: Result<{ continue: boolean }, undefined>) => {
            if (res.kind === "error") {
              return done(res);
            }
            if (res.value.continue) {
              return this.executeUntilBlocked(span, claimed, done);
            }
            return done(compRes);
          });
        }
        if (status.kind === "done") {
          return this.fulfillTask(claimed.task, status, () => done(compRes));
        }
      }
    });
  }

  // Extracted to allow tests to spy on computation creation.
  private createComputation(id: string, span: Span): Computation {
    return new Computation(
      id,
      this.clock,
      this.network,
      this.effects,
      this.retries,
      this.registry,
      this.heartbeat,
      this.dependencies,
      this.optsBuilder,
      this.verbose,
      this.tracer,
      span,
    );
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
    this.network.send(
      {
        kind: "task.suspend",
        head: { corrId: "", version: "" },
        data: {
          id: task.id,
          version: task.version,
          actions: status.awaited.map((a) => ({
            kind: "promise.register" as const,
            head: { corrId: "", version: "" },
            data: { awaiter: claimed.rootPromise.id, awaited: a },
          })),
        },
      },
      (res) => {
        if (isSuccess(res)) {
          return cb({ kind: "value", value: { continue: false } });
        }
        if (isRedirect(res)) {
          return cb({ kind: "value", value: { continue: true } });
        }
        const error = exceptions.SERVER_ERROR(res.data, true, {
          code: res.head.status,
          message: res.data,
        });
        error.log(this.verbose);
        return cb({ kind: "error", error: undefined });
      },
    );
  }

  private fulfillTask(task: TaskRecord, doneValue: Done, callback: () => void): void {
    let encoded: Value;
    try {
      encoded = this.codec.encode(doneValue.value);
    } catch (e) {
      const error = exceptions.ENCODING_RETV_UNENCODEABLE(doneValue.id, e);
      error.log(this.verbose);
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
              value: encoded,
            },
          },
        },
      },
      callback,
    );
  }

  public onMessage(msg: Message, cb: (res: Result<Status, undefined>) => void): void {
    util.assert(msg.kind === "execute");

    const task = msg.data.task;
    this.network.send(
      {
        kind: "task.acquire",
        head: { corrId: "", version: "" },
        data: { id: task.id, version: task.version, pid: this.pid, ttl: this.ttl },
      },
      (res) => {
        if (!isSuccess(res)) {
          const error = exceptions.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data,
          });
          error.log(this.verbose);
          return cb({ kind: "error", error: undefined });
        }

        let promise: PromiseRecord;
        try {
          promise = this.codec.decodePromise(res.data.promise);
        } catch (e) {
          return cb({ kind: "error", error: undefined });
        }

        const acquiredTask: TaskRecord = { id: task.id, state: "acquired", version: task.version };
        this.executeUntilBlocked(
          this.tracer.decode(msg.head),
          { kind: "claimed", task: acquiredTask, rootPromise: promise },
          (execRes) => {
            cb(execRes);
          },
        );
      },
    );
  }
}
