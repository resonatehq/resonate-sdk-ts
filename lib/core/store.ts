import { DurablePromiseRecord } from "./promises/types";

import { Schedule } from "./schedules/types";

/**
 * Store Interface
 */
export interface IStore {
  readonly promises: IPromiseStore;
  readonly schedules: IScheduleStore;
  readonly locks: ILockStore;
}

/**
 * Promise Store API
 */
export interface IPromiseStore {
  /**
   * Creates a new durable promise
   *
   * @param id Unique identifier for the promise.
   * @param ikey Idempotency key associated with the create operation.
   * @param strict If true, deduplicates only if the promise is pending.
   * @param headers Key value pairs associated with the data.
   * @param data Encoded data of type string.
   * @param timeout Time (in milliseconds) after which the promise is considered expired.
   * @param tags Key value pairs associated with the promise.
   * @returns A durable promise that is pending, canceled, resolved, or rejected.
   */
  create(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
    timeout: number,
    tags: Record<string, string> | undefined,
  ): Promise<DurablePromiseRecord>;

  /**
   * Cancels a new promise.
   *
   * @param id Unique identifier for the promise.
   * @param ikey Idempotency key associated with the create operation.
   * @param strict If true, deduplicates only if the promise is canceled.
   * @param headers Key value pairs associated with the data.
   * @param data Encoded data of type string.
   * @returns A durable promise that is canceled, resolved, or rejected.
   */
  cancel(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<DurablePromiseRecord>;

  /**
   * Resolves a promise.
   *
   * @param id Unique identifier for the promise to be resolved.
   * @param ikey Idempotency key associated with the resolve promise.
   * @param strict If true, deduplicates only if the promise is resolved.
   * @param headers Key value pairs associated with the data.
   * @param data Encoded data of type string.
   * @returns A durable promise that is canceled, resolved, or rejected.
   */
  resolve(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<DurablePromiseRecord>;

  /**
   * Rejects a promise
   *
   * @param id Unique identifier for the promise to be rejected.
   * @param ikey Integration key associated with the promise.
   * @param strict If true, deduplicates only if the promise is rejected.
   * @param headers Key value pairs associated with the data.
   * @param data Encoded data of type string.
   * @returns A durable promise that is canceled, resolved, or rejected.
   */
  reject(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<DurablePromiseRecord>;

  /**
   * Retrieves a promise based on its id.
   *
   * @param id Unique identifier for the promise to be retrieved.
   * @returns A durable promise that is pending, canceled, resolved, or rejected.
   */
  get(id: string): Promise<DurablePromiseRecord>;

  /**
   * Search for promises.
   *
   * @param id Ids to match, can include wildcards.
   * @param state State to match.
   * @param tags Tags to match.
   * @param limit Maximum number of promises to return.
   * @returns A list of Durable Promises.
   */
  search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit?: number,
  ): AsyncGenerator<DurablePromiseRecord[], void>;
}

/**
 * Schedule Store API
 */
export interface IScheduleStore {
  /**
   * Creates a new schedule.
   *
   * @param id Unique identifier for the schedule.
   * @param ikey Idempotency key associated with the create operation.
   * @param description Description of the schedule.
   * @param cron CRON expression defining the schedule's execution time.
   * @param tags Key-value pairs associated with the schedule.
   * @param promiseId Unique identifier for the associated promise.
   * @param promiseTimeout Timeout for the associated promise in milliseconds.
   * @param promiseHeaders Headers associated with the promise data.
   * @param promiseData Encoded data for the promise of type string.
   * @param promiseTags Key-value pairs associated with the promise.
   * @returns A Promise resolving to the created schedule.
   */
  create(
    id: string,
    ikey: string | undefined,
    description: string | undefined,
    cron: string,
    tags: Record<string, string> | undefined,
    promiseId: string,
    promiseTimeout: number,
    promiseHeaders: Record<string, string> | undefined,
    promiseData: string | undefined,
    promiseTags: Record<string, string> | undefined,
  ): Promise<Schedule>;

  /**
   * Retrieves a schedule based on its id.
   *
   * @param id Unique identifier for the promise to be retrieved.
   * @returns A promise schedule that is pending, canceled, resolved, or rejected.
   */
  get(id: string): Promise<Schedule>;

  /**
   * Deletes a schedule based on its id.
   * @param id Unique identifier for the promise to be deleted.
   * @returns A promise schedule that is pending, canceled, resolved, or rejected.
   */
  delete(id: string): Promise<void>;

  /**
   * Search for schedules.
   *
   * @param id Ids to match, can include wildcards.
   * @param tags Tags to match.
   * @returns A list of promise schedules.
   */
  search(id: string, tags: Record<string, string> | undefined, limit?: number): AsyncGenerator<Schedule[], void>;
}

/**
 * Lock Store API
 */
export interface ILockStore {
  /**
   * Try to acquire a lock.
   *
   * @param id Id of lock.
   * @param eid Execution id of lock.
   * @param expiry Time in ms before lock will expire.
   * @returns A boolean indicating whether or not the lock was acquired.
   */
  tryAcquire(id: string, eid: string, expiry?: number): Promise<boolean>;

  /**
   * Release a lock.
   *
   * @param id Id of lock.
   * @param eid Execution id of lock.
   */
  release(id: string, eid: string): Promise<boolean>;
}
