import assert from "assert";
import { Resonate } from "../resonate";
import { ErrorCodes, ResonateError } from "./errors";
import { RetryPolicy, isRetryPolicy } from "./retry";
import { TaskMessage, TasksSource } from "./tasksSource";
import * as utils from "./utils";

export type ResumeBody = {
  promiseId: string;
  topLevelParent: {
    id: string;
    name: string;
    version: number;
    args: any[];
    retryPolicy: RetryPolicy;
  };
};

export function isResumeBody(value: unknown): value is ResumeBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "promiseId" in value &&
    typeof value.promiseId === "string" &&
    "topLevelParent" in value &&
    typeof value.topLevelParent === "object" &&
    value.topLevelParent !== null &&
    "id" in value.topLevelParent &&
    typeof value.topLevelParent.id === "string" &&
    "name" in value.topLevelParent &&
    typeof value.topLevelParent.name === "string" &&
    "version" in value.topLevelParent &&
    typeof value.topLevelParent.version === "number" &&
    "args" in value.topLevelParent &&
    Array.isArray(value.topLevelParent.args) &&
    "retryPolicy" in value.topLevelParent &&
    typeof value.topLevelParent.retryPolicy === "object" &&
    isRetryPolicy(value.topLevelParent.retryPolicy)
  );
}

export class TasksHandler {
  #resonate: Resonate;
  #source: TasksSource;
  #callbackPromises: Map<string, { resolve: (value: any) => void; reject: (reason?: any) => void }>;

  constructor(resonate: Resonate, source: TasksSource) {
    this.#resonate = resonate;
    this.#source = source;
    this.#callbackPromises = new Map();
  }

  async start(): Promise<void> {
    for await (const task of this.#source.generator) {
      // Generator only gets us bytes back, we need to encode those into an object
      // Don't await so we can process more events concurrently
      await this.handleTask(task);
    }
  }

  private async handleTask(task: TaskMessage): Promise<void> {
    const resumeBody = await this.#resonate.store.tasks.claim(task.id, task.counter);

    const opts = this.#resonate.defaultInvocationOptions;

    const { promiseId, topLevelParent } = resumeBody;
    const parentInvocation = this.#resonate.getInvocationHandle(topLevelParent.id);

    if (!parentInvocation) {
      this.#resonate.invokeLocal(
        topLevelParent.name,
        topLevelParent.id,
        ...topLevelParent.args,
        this.#resonate.options({
          retryPolicy: topLevelParent.retryPolicy,
          version: topLevelParent.version,
        }),
      );
    } else {
      const callbackResolvers = this.#callbackPromises.get(promiseId);
      if (!callbackResolvers) {
        assert(false, "Callback promise not found");
        return;
      }

      const { resolve: callbackResolve, reject: callbackReject } = callbackResolvers;
      const storedPromise = await this.#resonate.store.promises.get(promiseId);

      switch (storedPromise.state) {
        case "RESOLVED":
          callbackResolve(opts.encoder.decode(storedPromise.value.data));
          break;
        case "REJECTED":
          callbackReject(opts.encoder.decode(storedPromise.value.data));
          break;
        case "REJECTED_CANCELED":
          callbackReject(
            new ResonateError(
              "Resonate function canceled",
              ErrorCodes.CANCELED,
              opts.encoder.decode(storedPromise.value.data),
            ),
          );
          break;
        case "REJECTED_TIMEDOUT":
          callbackReject(
            new ResonateError(
              `Resonate function timedout at ${new Date(storedPromise.timeout).toISOString()}`,
              ErrorCodes.TIMEDOUT,
            ),
          );
          break;
        case "PENDING":
          // unreachable
          assert(
            false,
            "Stored promise is pending after a callback has been created for it, please report this bug to resonate mantainers",
          );
      }
    }
    await this.#resonate.store.tasks.complete(task.id, task.counter);
  }

  localCallback<R>(promiseId: string): Promise<R> {
    const { promise, resolve, reject } = utils.promiseWithResolvers();
    this.#callbackPromises.set(promiseId, { resolve, reject });
    return promise as Promise<R>;
  }

  callbackUrl() {
    return this.#source.callbackUrl();
  }

  stop() {
    this.#source.stop();
  }
}
