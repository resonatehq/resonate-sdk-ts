import {
  DurablePromise,
  PendingPromise,
  ResolvedPromise,
  RejectedPromise,
  CanceledPromise,
  TimedoutPromise,
  isPendingPromise,
  isResolvedPromise,
  isRejectedPromise,
  isCanceledPromise,
} from "../promise";
import { Schedule } from "../schedule";
import { IPromiseStore } from "../store";
import { ErrorCodes, ResonateError } from "../error";
import { IStorage, WithTimeout } from "../storage";
import { MemoryStorage } from "../storages/memory";

export class LocalPromiseStore implements IPromiseStore {
  private storage: IStorage;
  private schedules: Schedule[] = [];

  constructor(storage: IStorage = new MemoryStorage()) {
    this.storage = new WithTimeout(storage);
    this.startControlLoop();
  }

  private startControlLoop() {
    setInterval(() => {
      this.handleSchedules();
    }, 1000); // Adjust the interval as needed
  }

  private async handleSchedules() {
    for (const schedule of this.schedules) {
      const delay = Math.max(0, schedule.nextRunTime ? - Date.now() : 0);

      setTimeout(async () => {
        try {
          await this.createPromiseFromSchedule(schedule);
          // Log or handle the created promise as needed
        } catch (error) {
          console.error("Error creating promise:", error);
        }
      }, delay);
    }
  }

  private async createPromiseFromSchedule(schedule: Schedule): Promise<DurablePromise | undefined> {
    return this.storage.rmw(schedule.id, (promise): DurablePromise | undefined => {
      if (promise) {
        // Handle existing promise based on schedule
        // Update lastRunTime and nextRunTime in a transaction
      } else {
        // Create a new promise based on the schedule
        const newPromise: DurablePromise = {
          state: "PENDING",
          id: schedule.promiseId,
          timeout: schedule.promiseTimeout,
          param: {
            headers: schedule.promiseParam?.headers,
            data: schedule.promiseParam?.data,
          },
          value: {
            headers: undefined,
            data: undefined,
          },
          createdOn: Date.now(),
          completedOn: undefined,
          idempotencyKeyForCreate: undefined,
          idempotencyKeyForComplete: undefined,
          tags: schedule.promiseTags,
        };
        return newPromise;
      }
    });
  }

  async create(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
    timeout: number,
    tags: Record<string, string> | undefined,
  ): Promise<PendingPromise | ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    return this.storage.rmw(id, (promise) => {
      if (promise) {
        if (strict && !isPendingPromise(promise)) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        if (promise.idempotencyKeyForCreate === undefined || ikey != promise.idempotencyKeyForCreate) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        return promise;
      } else {
        return {
          state: "PENDING",
          id: id,
          timeout: timeout,
          param: {
            headers: headers,
            data: data,
          },
          value: {
            headers: undefined,
            data: undefined,
          },
          createdOn: Date.now(),
          completedOn: undefined,
          idempotencyKeyForCreate: ikey,
          idempotencyKeyForComplete: undefined,
          tags: tags,
        };
      }
    });
  }

  async resolve(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    return this.storage.rmw(id, (promise) => {
      if (promise) {
        if (strict && !isPendingPromise(promise) && !isResolvedPromise(promise)) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        if (isPendingPromise(promise)) {
          return {
            state: "RESOLVED",
            id: promise.id,
            timeout: promise.timeout,
            param: promise.param,
            value: {
              headers: headers,
              data: data,
            },
            createdOn: promise.createdOn,
            completedOn: Date.now(),
            idempotencyKeyForCreate: promise.idempotencyKeyForCreate,
            idempotencyKeyForComplete: ikey,
            tags: promise.tags,
          };
        }

        if (promise.idempotencyKeyForComplete === undefined || ikey != promise.idempotencyKeyForComplete) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        return promise;
      } else {
        throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found");
      }
    });
  }

  async reject(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    return this.storage.rmw(id, (promise) => {
      if (promise) {
        if (strict && !isPendingPromise(promise) && !isRejectedPromise(promise)) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        if (isPendingPromise(promise)) {
          return {
            state: "REJECTED",
            id: promise.id,
            timeout: promise.timeout,
            param: promise.param,
            value: {
              headers: headers,
              data: data,
            },
            createdOn: promise.createdOn,
            completedOn: Date.now(),
            idempotencyKeyForCreate: promise.idempotencyKeyForCreate,
            idempotencyKeyForComplete: ikey,
            tags: promise.tags,
          };
        }

        if (promise.idempotencyKeyForComplete === undefined || ikey != promise.idempotencyKeyForComplete) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        return promise;
      } else {
        throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found");
      }
    });
  }

  async cancel(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    return this.storage.rmw(id, (promise) => {
      if (promise) {
        if (strict && !isPendingPromise(promise) && !isCanceledPromise(promise)) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        if (isPendingPromise(promise)) {
          return {
            state: "REJECTED_CANCELED",
            id: promise.id,
            timeout: promise.timeout,
            param: promise.param,
            value: {
              headers: headers,
              data: data,
            },
            createdOn: promise.createdOn,
            completedOn: Date.now(),
            idempotencyKeyForCreate: promise.idempotencyKeyForCreate,
            idempotencyKeyForComplete: ikey,
            tags: promise.tags,
          };
        }

        if (promise.idempotencyKeyForComplete === undefined || ikey != promise.idempotencyKeyForComplete) {
          throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request");
        }

        return promise;
      } else {
        throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found");
      }
    });
  }

  async get(id: string): Promise<DurablePromise> {
    const promise = await this.storage.rmw(id, (p) => p);

    if (promise) {
      return promise;
    }

    throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found");
  }

  search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<DurablePromise[], void> {
    return this.storage.search(id, state, tags, limit);
  }

  async createSchedule(
    id: string,
    ikey: string | undefined,
    description: string | undefined,
    cron: string,
    tags: Record<string, string> | undefined,
    promiseId: string,
    promiseTimeout: number,
    promiseHeaders: Record<string, string>,
    promiseData: string | undefined,
    promiseTags: Record<string, string> | undefined,
  ): Promise<Schedule> {
    const schedule = {
      id,
      description,
      cron,
      tags,
      promiseId,
      promiseTimeout,
      promiseParam: {
        headers: promiseHeaders,
        data: promiseData,
      },
      promiseTags,
      lastRunTime: undefined,
      nextRunTime: undefined,
      idempotencyKey: ikey,
      createdOn: Date.now(),
    };

    this.schedules.push(schedule);

    return schedule;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const index = this.schedules.findIndex((schedule) => schedule.id === id);

    if (index !== -1) {
      this.schedules.splice(index, 1);
    }

    return true;
  }

  async getSchedule(id: string): Promise<Schedule> {
    const schedule = this.schedules.find((schedule) => schedule.id === id);

    if (schedule) {
      return schedule;
    }

    throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found");
  }
  async searchSchedules(
    id: string,
    tags?: Record<string, string>,
    limit?: number,
    cursor?: string | undefined,
  ): Promise<{ cursor: string; schedules: Schedule[] }> {
    let filteredSchedules = this.schedules.filter((schedule) => schedule.id === id);

    if (tags) {
      filteredSchedules = filteredSchedules.filter((schedule) =>
        Object.entries(tags).every(([key, value]) => schedule.tags && schedule.tags[key] === value),
      );
    }

    if (cursor !== undefined) {
      const cursorIndex = filteredSchedules.findIndex((schedule) => schedule.id === cursor);
      if (cursorIndex !== -1) {
        filteredSchedules = filteredSchedules.slice(cursorIndex + 1);
      }
    }

    if (limit !== undefined) {
      filteredSchedules = filteredSchedules.slice(0, limit);
    }

    const nextCursor = filteredSchedules.length > 0 ? filteredSchedules[filteredSchedules.length - 1].id : null;

    return {
      cursor: nextCursor ?? "",
      schedules: filteredSchedules,
    };
  }
}
