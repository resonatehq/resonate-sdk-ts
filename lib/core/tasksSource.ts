/**
 * Represents a single task message, which contains an ID and a counter.
 */
export type TaskMessage = {
  /**
   * The unique identifier of the task message.
   */
  id: string;
  /**
   * The counter or sequence number of the task message.
   */
  counter: number;
};

/**
 * Checks if the given value is a `TaskMessage` object.
 *
 * @param value - The value to be checked.
 * @returns `true` if the value is a `TaskMessage` object, `false` otherwise.
 */
export function isTaskMessage(value: unknown): value is TaskMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "counter" in value &&
    typeof value.counter === "number"
  );
}

/**
 * Represents a source of task messages, providing an asynchronous generator
 * to iterate over the messages, and methods to receive and stop the task source.
 */
export interface TasksSource {
  /**
   * An asynchronous generator that yields `TaskMessage` objects.
   */
  readonly generator: AsyncGenerator<TaskMessage, void, unknown>;

  /**
   * Retrieves the URL of the task source.
   *
   * @returns The URL of the task source.
   */
  callbackUrl(): string;

  /**
   * Stops the task source, finishes the generator and releases any associated resources.
   */
  stop(): void;
}
