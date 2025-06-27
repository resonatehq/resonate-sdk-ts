import * as cronParser from "cron-parser";
import { ErrorCodes, ResonateError } from "../errors";
import {
  DurablePromiseRecord,
  isPendingPromise,
  isResolvedPromise,
  isRejectedPromise,
  isCanceledPromise,
  isTimedoutPromise,
} from "../promises/types";
import { Schedule } from "../schedules/types";
import { IStorage } from "../storage";
import { MemoryStorage } from "../storages/memory";
import { WithTimeout } from "../storages/withTimeout";
import { IStore, IPromiseStore, IScheduleStore } from "../store";

export class LocalStore implements IStore {
  public promises: LocalPromiseStore;
  public schedules: LocalScheduleStore;

  constructor() {
    this.promises = new LocalPromiseStore(
      new WithTimeout(new MemoryStorage<DurablePromiseRecord>()),
    );
    this.schedules = new LocalScheduleStore(new MemoryStorage<Schedule>());
  }

  tick(time: number): number {
    // schedule promises

    // reenqueue tasks

    // timeout promises

    // calculate next tick time, min of:
    // - next promise timeout
    // - next schedule run time
    // - next task expiration time

    // return next tick time

    return 0;
  }
}

export class LocalPromiseStore implements IPromiseStore {
  constructor(private storage: IStorage<DurablePromiseRecord>) {}

  async create(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
    timeout: number,
    tags: Record<string, string> | undefined,
  ): Promise<DurablePromiseRecord> {
    return this.storage.rmw(id, (promise) => {
      if (!promise) {
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

      if (strict && !isPendingPromise(promise)) {
        throw new ResonateError(
          "Forbidden request: Durable promise previously created",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      if (
        promise.idempotencyKeyForCreate === undefined ||
        ikey !== promise.idempotencyKeyForCreate
      ) {
        throw new ResonateError(
          "Forbidden request: Missing idempotency key for create",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      return promise;
    });
  }

  async resolve(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<DurablePromiseRecord> {
    return this.storage.rmw(id, (promise) => {
      if (!promise) {
        throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
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

      if (strict && !isResolvedPromise(promise)) {
        throw new ResonateError(
          "Forbidden request",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      if (
        !isTimedoutPromise(promise) &&
        (promise.idempotencyKeyForComplete === undefined ||
          ikey !== promise.idempotencyKeyForComplete)
      ) {
        throw new ResonateError(
          "Forbidden request",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      return promise;
    });
  }

  async reject(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<DurablePromiseRecord> {
    return this.storage.rmw(id, (promise) => {
      if (!promise) {
        throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
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

      if (strict && !isRejectedPromise(promise)) {
        throw new ResonateError(
          "Forbidden request",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      if (
        !isTimedoutPromise(promise) &&
        (promise.idempotencyKeyForComplete === undefined ||
          ikey !== promise.idempotencyKeyForComplete)
      ) {
        throw new ResonateError(
          "Forbidden request",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      return promise;
    });
  }

  async cancel(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<DurablePromiseRecord> {
    return this.storage.rmw(id, (promise) => {
      if (!promise) {
        throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
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

      if (strict && !isCanceledPromise(promise)) {
        throw new ResonateError(
          "Forbidden request",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      if (
        !isTimedoutPromise(promise) &&
        (promise.idempotencyKeyForComplete === undefined ||
          ikey !== promise.idempotencyKeyForComplete)
      ) {
        throw new ResonateError(
          "Forbidden request",
          ErrorCodes.STORE_FORBIDDEN,
        );
      }

      return promise;
    });
  }

  async get(id: string): Promise<DurablePromiseRecord> {
    const promise = await this.storage.rmw(id, (p) => p);

    if (!promise) {
      throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
    }

    return promise;
  }
}

export class LocalScheduleStore implements IScheduleStore {
  constructor(private storage: IStorage<Schedule>) {}

  async create(
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
    const schedule = await this.storage.rmw(id, (schedule) => {
      if (schedule) {
        if (
          schedule.idempotencyKey === undefined ||
          ikey != schedule.idempotencyKey
        ) {
          throw new ResonateError(
            "Already exists",
            ErrorCodes.STORE_ALREADY_EXISTS,
          );
        }
        return schedule;
      }

      const createdOn = Date.now();

      let nextRunTime: number;
      try {
        nextRunTime = this.nextRunTime(cron, createdOn);
      } catch (error) {
        throw ResonateError.fromError(error);
      }

      return {
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
        nextRunTime: nextRunTime,
        idempotencyKey: ikey,
        createdOn: createdOn,
      };
    });

    if (this.store) {
      this.store.addSchedule(schedule);
    }

    return schedule;
  }

  async update(id: string, lastRunTime: number): Promise<Schedule | undefined> {
    const schedule = await this.storage.rmw(id, (schedule) => {
      if (!schedule) {
        throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
      }

      // update iff not already updated
      if (schedule.nextRunTime === lastRunTime) {
        let nextRunTime: number;
        try {
          nextRunTime = this.nextRunTime(schedule.cron, lastRunTime);
        } catch (error) {
          throw ResonateError.fromError(error);
        }

        schedule.lastRunTime = lastRunTime;
        schedule.nextRunTime = nextRunTime;
      }

      return schedule;
    });

    if (this.store) {
      this.store.addSchedule(schedule);
    }

    return schedule;
  }

  async delete(id: string): Promise<void> {
    const result = await this.storage.rmd(id, () => true);
    if (!result) {
      throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
    }

    if (this.store) {
      this.store.deleteSchedule(id);
    }
  }

  async get(id: string): Promise<Schedule> {
    const schedule = await this.storage.rmw(id, (s) => s);

    if (!schedule) {
      throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
    }

    return schedule;
  }

  private nextRunTime(cron: string, lastRunTime: number): number {
    return cronParser
      .parseExpression(cron, { currentDate: new Date(lastRunTime) })
      .next()
      .getTime();
  }
}
