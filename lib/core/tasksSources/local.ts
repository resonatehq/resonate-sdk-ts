import { isCompletedPromise } from "../promises/types";
import { LocalStore } from "../stores/local";
import { TaskMessage, TasksSource } from "../tasksSource";
import * as utils from "../utils";

export class LocalTasksSource implements TasksSource {
  private store: LocalStore;
  private tasksQueue: TaskMessage[] = [];
  private resolver: ((taskMessage: TaskMessage) => void) | undefined;
  private stopPromise: utils.PromiseWithResolvers<void> = utils.promiseWithResolvers<void>();
  private pollingTimeout: NodeJS.Timeout | undefined;
  readonly generator: AsyncGenerator<TaskMessage, void, unknown>;

  constructor(store: LocalStore) {
    this.generator = this._generator();
    this.store = store;
  }

  stop(): void {
    clearTimeout(this.pollingTimeout);
    this.stopPromise.reject("Stop local task source");
  }

  callbackUrl(): string {
    return "";
  }

  async start(): Promise<void> {
    clearTimeout(this.pollingTimeout);

    this.pollingTimeout = setInterval(async () => {
      for (const { callback } of await this.store.callbacks.getAll()) {
        const promise = await this.store.promises.get(callback.id);
        if (isCompletedPromise(promise)) {
          if (this.resolver) {
            this.resolver({ id: promise.id, counter: 0 });
          } else {
            this.tasksQueue.push({ id: promise.id, counter: 0 });
          }
        }
      }
    }, 500);
  }

  private async *_generator(): AsyncGenerator<TaskMessage, void, unknown> {
    const waitForTask = (): Promise<TaskMessage> => {
      const taskPromise = new Promise((resolve) => {
        if (this.tasksQueue.length > 0) {
          resolve(this.tasksQueue.shift()!);
        } else {
          this.resolver = (taskMessage: TaskMessage) => resolve(taskMessage);
        }
      });
      return Promise.race([taskPromise, this.stopPromise.promise]) as Promise<TaskMessage>;
    };

    try {
      while (true) {
        const task = await waitForTask();
        yield task;
      }
    } catch {
      // Intentionally left blank
      // This function is not expected to fail
      // It is necessary to have a try/catch to correctly handle stop().
    }
  }
}
