import * as cronParser from "cron-parser";
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
  isDurablePromise,
} from "../promise";
import { Schedule, isSchedule } from "../schedule";
import { IPromiseStore } from "../store";
import { ErrorCodes, ResonateError } from "../error";
import { IStorage, WithTimeout } from "../storage";
import { MemoryStorage } from "../storages/memory";

export class LocalPromiseStore implements IPromiseStore {
  private storage: IStorage;

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
    const result = await this.storage.search("id", "schedules", undefined, undefined, undefined);

    const schedules: Schedule[] = [];
    for await (const item of result) {
      if (isSchedule(item)) {
        schedules.push(item);
      }
    }
    for (const schedule of schedules) {
      const delay = Math.max(0, schedule.nextRunTime ? -Date.now() : 0);

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
        // TODO: Handle existing promise based on schedule
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
      if (isDurablePromise(promise)) {
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
      if (isDurablePromise(promise)) {
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
      if (isDurablePromise(promise)) {
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
      if (isDurablePromise(promise)) {
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

    if (isDurablePromise(promise)) {
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
    return this.storage.search(id, "promise", state, tags, limit) as AsyncGenerator<DurablePromise[], void>;
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
      nextRunTime: this.calculateNextRunTime(cron),
      idempotencyKey: ikey,
      createdOn: Date.now(),
    };

    return this.storage.rmw(id, (s) => {
      if (s) {
        throw new ResonateError(ErrorCodes.ALREADY_EXISTS, "Already Exists");
      }

      return schedule;
    });
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.storage.deleteSchedule(id);
  }

  async getSchedule(id: string): Promise<Schedule> {
    const schedule = await this.storage.rmw<Schedule>(id, (s) => {
      if (isSchedule(s)) {
        return s;
      } else {
        throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found");
      }
    });

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
    try {
      const result = await this.storage.search(id, "schedules", undefined, undefined, undefined);

      const scheduleList: Schedule[] = [];
      for await (const item of result) {
        for await (const elem of item) {
          if (isSchedule(elem)) {
            scheduleList.push(elem);
          }
        }
      }

      // Filter schedules based on the provided parameters
      let filteredSchedules = scheduleList.filter((schedule) => schedule.id === id);

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
    } catch (error) {
      console.error("Error searching schedules:", error);
      throw new ResonateError(ErrorCodes.UNKNOWN, "Internal error");
    }
  }

  private parseCronExpression(cron: string): Date {
    try {
      return cronParser.parseExpression(cron).next().toDate();
    } catch (error) {
      throw new Error(`Error parsing cron expression: ${error}`);
    }
  }

  private validateNextRunTime(nextRunDate: Date): number {
    const nextRunTime = nextRunDate.getTime();
    if (isNaN(nextRunTime)) {
      throw new Error("Invalid next run time");
    }
    return nextRunTime;
  }

  private calculateNextRunTime(cron: string): number | undefined {
    try {
      const nextRunDate = this.parseCronExpression(cron);
      return this.validateNextRunTime(nextRunDate);
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }
}
