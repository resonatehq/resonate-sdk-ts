import { TaskMessage, TasksSource } from "../tasksSource";
import * as utils from "../utils";

export class LocalTasksSource implements TasksSource {
  private taskQueue: TaskMessage[] = [];
  private resolver: ((taskMessage: TaskMessage) => void) | undefined;
  private stopPromise: utils.PromiseWithResolvers<void> = utils.promiseWithResolvers<void>();
  readonly generator: AsyncGenerator<TaskMessage, void, unknown>;

  constructor() {
    this.generator = this._generator();
  }

  stop(): void {
    this.stopPromise.reject();
  }

  callbackUrl(): string {
    return "";
  }

  private async *_generator(): AsyncGenerator<TaskMessage, void, unknown> {
    const waitForTask = (): Promise<TaskMessage> => {
      const taskPromise = new Promise((resolve) => {
        if (this.taskQueue.length > 0) {
          resolve(this.taskQueue.shift()!);
        } else {
          this.resolver = (taskMessage: TaskMessage) => resolve(taskMessage);
        }
      });

      return Promise.race([this.stopPromise.promise, taskPromise]) as Promise<TaskMessage>;
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

  emitTask(taskMessage: TaskMessage) {
    if (this.resolver) {
      this.resolver(taskMessage);
      this.resolver = undefined;
    } else {
      this.taskQueue.push(taskMessage);
    }
  }
}
