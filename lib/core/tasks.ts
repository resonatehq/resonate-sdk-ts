import assert from "assert";
import { Resonate } from "../resonate";
import { DurablePromiseRecord, handleCompletedPromise, isDurablePromiseRecord } from "./promises/types";
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

export type CallbackRecord = {
  callback: {
    id: string;
    promiseId: string;
    message: {
      recv: string;
      // base64 encoded
      data: any;
    };
    timeout: number;
    createdOn: number;
  };
  promise: DurablePromiseRecord;
};

export function isCallbackRecord(obj: unknown): obj is CallbackRecord {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const record = obj as CallbackRecord;

  return (
    typeof record.callback === "object" &&
    record.callback !== null &&
    typeof record.callback.id === "string" &&
    typeof record.callback.promiseId === "string" &&
    typeof record.callback.message === "object" &&
    record.callback.message !== null &&
    typeof record.callback.message.recv === "string" &&
    // We don't check the type of data as it's 'any'
    typeof record.callback.timeout === "number" &&
    typeof record.callback.createdOn === "number" &&
    isDurablePromiseRecord(record.promise)
  );
}

export class TasksHandler {
  #resonate: Resonate;
  #source: TasksSource;
  #callbackPromises: Map<string, utils.PromiseWithResolvers<unknown>>;

  constructor(resonate: Resonate, source: TasksSource) {
    this.#resonate = resonate;
    this.#source = source;
    this.#callbackPromises = new Map();
  }

  async start(): Promise<void> {
    this.listenTasks();
  }

  async listenTasks(): Promise<void> {
    for await (const task of this.#source.generator) {
      // Don't await so we can process more events concurrently
      this.handleTask(task);
    }
  }

  private async handleTask(task: TaskMessage): Promise<void> {
    try {
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
          this.#resonate.logger.warn(`There was no local callback registered for ${promiseId}`);
          return;
        }

        const { resolve: callbackResolve, reject: callbackReject } = callbackResolvers;
        const storedPromise = await this.#resonate.store.promises.get(promiseId);

        if (storedPromise.state === "PENDING") {
          assert(
            false,
            "Stored promise is pending after a task was created to resume it, please report this bug to resonate mantainers",
          );
        }

        try {
          const data = handleCompletedPromise(storedPromise, opts.encoder);
          callbackResolve(data);
        } catch (err) {
          callbackReject(err);
        }
      }
      await this.#resonate.store.tasks.complete(task.id, task.counter);
    } catch (err) {
      this.#resonate.logger.warn("Error happened while trying to process a task:", err);
    }
  }

  localCallback<R>(promiseId: string): Promise<R> {
    // If we have created a callback for this promise already just return it.
    const callbackPromise = this.#callbackPromises.get(promiseId);
    if (callbackPromise) {
      return callbackPromise.promise as Promise<R>;
    }

    const { promise, resolve, reject } = utils.promiseWithResolvers();
    this.#callbackPromises.set(promiseId, { promise, resolve, reject });
    return promise as Promise<R>;
  }

  callbackUrl() {
    return this.#source.callbackUrl();
  }

  stop() {
    this.#source.stop();
  }
}
