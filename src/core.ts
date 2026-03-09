import type { Clock } from "./clock.js";
import type { Codec } from "./codec.js";
import { Computation, type Done, type Status } from "./computation.js";
import exceptions, { type ResonateError } from "./exceptions.js";
import type { Heartbeat } from "./heartbeat.js";
import { isRedirect, isSuccess, type Message, type PromiseRecord, type TaskRecord } from "./network/types.js";
import type { OptionsBuilder } from "./options.js";
import type { Registry } from "./registry.js";
import { Constant, Exponential, Linear, Never, type RetryPolicyConstructor } from "./retries.js";
import type { Effects, Result, Send } from "./types.js";
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
  preload?: PromiseRecord[];
};

export type UnclaimedTask = {
  kind: "unclaimed";
  task: TaskRecord;
};

export class Core {
  private pid: string;
  private ttl: number;
  private clock: Clock;
  private send: Send;
  private codec: Codec;
  private retries: Map<string, RetryPolicyConstructor>;
  private registry: Registry;
  private heartbeat: Heartbeat;
  private dependencies: Map<string, any>;
  private optsBuilder: OptionsBuilder;
  private verbose: boolean;

  constructor({
    pid,
    ttl,
    clock,
    send,
    codec,
    registry,
    heartbeat,
    dependencies,
    optsBuilder,
    verbose,
  }: {
    pid: string;
    ttl: number;
    clock: Clock;
    send: Send;
    codec: Codec;
    registry: Registry;
    heartbeat: Heartbeat;
    dependencies: Map<string, any>;
    optsBuilder: OptionsBuilder;
    verbose: boolean;
  }) {
    this.pid = pid;
    this.ttl = ttl;
    this.clock = clock;
    this.send = send;
    this.codec = codec;
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
  }

  public async executeUntilBlocked(claimed: ClaimedTask): Promise<Result<Status, ResonateError | undefined>> {
    const computation = this.createComputation(
      claimed.rootPromise.id,
      util.buildEffects(this.send, this.codec, claimed.preload),
    );

    try {
      const compRes = await computation.executeUntilBlocked(claimed);
      if (compRes.kind === "error") {
        await this.releaseTask(claimed.task);
        return compRes;
      }
      const status = compRes.value;
      if (status.kind === "suspended") {
        const suspendRes = await this.suspendTask(claimed, status);
        if (suspendRes.kind === "error") {
          return suspendRes;
        }
        if (suspendRes.value.continue) {
          claimed.preload = suspendRes.value.preload;
          return this.executeUntilBlocked(claimed);
        }
        return compRes;
      }
      if (status.kind === "done") {
        await this.fulfillTask(claimed.task, status);
        return compRes;
      }
      return compRes;
    } catch (err) {
      console.warn("executeUntilBlocked failed unexpectedly", err);
      await this.releaseTask(claimed.task).catch(() => {});
      return { kind: "error", error: undefined };
    }
  }

  // Extracted to allow tests to spy on computation creation.
  private createComputation(id: string, effects: Effects): Computation {
    return new Computation(
      id,
      this.clock,
      effects,
      this.retries,
      this.registry,
      this.heartbeat,
      this.dependencies,
      this.optsBuilder,
      this.verbose,
    );
  }

  private async releaseTask(task: TaskRecord): Promise<void> {
    const result = await this.send({
      kind: "task.release",
      head: { corrId: "", version: "" },
      data: { id: task.id, version: task.version },
    });
    if (result.kind === "error") {
      result.error.log(this.verbose);
    }
  }

  private async suspendTask(
    claimed: ClaimedTask,
    status: { kind: "suspended"; awaited: string[] },
  ): Promise<Result<{ continue: true; preload: PromiseRecord[] } | { continue: false }, ResonateError>> {
    const task = claimed.task;
    const sendResult = await this.send({
      kind: "task.suspend",
      head: { corrId: "", version: "" },
      data: {
        id: task.id,
        version: task.version,
        actions: status.awaited.map((a) => ({
          kind: "promise.register_callback",
          head: { corrId: "", version: "" },
          data: { awaiter: claimed.rootPromise.id, awaited: a },
        })),
      },
    });
    if (sendResult.kind === "error") {
      sendResult.error.log(this.verbose);
      return { kind: "error", error: sendResult.error };
    }
    const res = sendResult.value;
    if (isSuccess(res)) {
      return { kind: "value", value: { continue: false } };
    }
    if (isRedirect(res)) {
      return { kind: "value", value: { continue: true, preload: res.data.preload } };
    }
    const error = exceptions.SERVER_ERROR(res.data, true, {
      code: res.head.status,
      message: res.data,
    });
    error.log(this.verbose);
    return { kind: "error", error };
  }

  private async fulfillTask(task: TaskRecord, doneValue: Done): Promise<void> {
    const encodeResult = this.codec.encode(doneValue.value);
    if (encodeResult.kind === "error") {
      const error = exceptions.ENCODING_RETV_UNENCODEABLE(doneValue.id, encodeResult.error);
      error.log(this.verbose);
      return;
    }

    const sendResult = await this.send({
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
            value: encodeResult.value,
          },
        },
      },
    });
    if (sendResult.kind === "error") {
      sendResult.error.log(this.verbose);
    }
  }

  public async onMessage(msg: Message): Promise<Result<Status, ResonateError | undefined>> {
    util.assert(msg.kind === "execute");

    const task = msg.data.task;
    const sendResult = await this.send({
      kind: "task.acquire",
      head: { corrId: "", version: "" },
      data: { id: task.id, version: task.version, pid: this.pid, ttl: this.ttl },
    });

    if (sendResult.kind === "error") {
      sendResult.error.log(this.verbose);
      return { kind: "error", error: undefined };
    }
    const res = sendResult.value;

    if (!isSuccess(res)) {
      const error = exceptions.SERVER_ERROR(res.data, true, {
        code: res.head.status,
        message: res.data,
      });
      error.log(this.verbose);
      return { kind: "error", error: undefined };
    }

    const decodeResult = this.codec.decodePromise(res.data.promise);
    if (decodeResult.kind === "error") {
      decodeResult.error.log(this.verbose);
      return { kind: "error", error: undefined };
    }

    return this.executeUntilBlocked({
      kind: "claimed",
      task: res.data.task,
      rootPromise: decodeResult.value,
      preload: res.data.preload,
    });
  }
}
