import * as cronParser from "cron-parser";
import { ErrorCodes, ResonateError } from "../errors";
import { ILogger } from "../logger";
import { Logger } from "../loggers/logger";
import { StoreOptions } from "../options";
import {
  DurablePromiseRecord,
  isPendingPromise,
  isResolvedPromise,
  isRejectedPromise,
  isCanceledPromise,
  isTimedoutPromise,
  isCompletedPromise,
} from "../promises/types";
import { Schedule } from "../schedules/types";
import { IStorage } from "../storage";
import { MemoryStorage } from "../storages/memory";
import { WithTimeout } from "../storages/withTimeout";
import { IStore, IPromiseStore, IScheduleStore, ILockStore, ICallbackStore, ITaskStore } from "../store";
import { ResumeBody, isResumeBody } from "../tasks";
import { LocalTasksSource } from "../tasksSources/local";

export class LocalStore implements IStore {
  public promises: LocalPromiseStore;
  public schedules: LocalScheduleStore;
  public locks: LocalLockStore;
  public callbacks: LocalCallbackStore;
  public tasks: LocalTaskStore;

  public readonly logger: ILogger;

  private toSchedule: Schedule[] = [];
  private next: number | undefined = undefined;
  private tasksSource: LocalTasksSource;
  private callbacksTimeout: NodeJS.Timeout | undefined;

  constructor(
    tasksSource: LocalTasksSource,
    opts: Partial<StoreOptions> = {},
    promiseStorage: IStorage<DurablePromiseRecord> = new WithTimeout(new MemoryStorage<DurablePromiseRecord>()),
    scheduleStorage: IStorage<Schedule> = new MemoryStorage<Schedule>(),
    lockStorage: IStorage<{ id: string; eid: string }> = new MemoryStorage<{ id: string; eid: string }>(),
    callbacksStorage: IStorage<{ id: string; data: string }> = new MemoryStorage<{
      id: string;
      data: string;
    }>(),
    taskStorage: IStorage<{ id: string; counter: number; data: string }> = new MemoryStorage<{
      id: string;
      counter: number;
      data: string;
    }>(),
  ) {
    this.callbacks = new LocalCallbackStore(this, callbacksStorage);
    this.promises = new LocalPromiseStore(this, promiseStorage);
    this.schedules = new LocalScheduleStore(this, scheduleStorage);
    this.locks = new LocalLockStore(this, lockStorage);
    this.tasks = new LocalTaskStore(this, taskStorage);

    this.logger = opts.logger ?? new Logger();
    this.tasksSource = tasksSource;

    this.init();
    this.handleCallbacks();
  }

  stop(): void {
    clearTimeout(this.next);
    this.next = undefined;
    clearTimeout(this.callbacksTimeout);
    this.callbacksTimeout = undefined;
  }

  // handler the schedule store can call
  addSchedule(schedule: Schedule) {
    this.toSchedule = this.toSchedule.filter((s) => s.id != schedule.id).concat(schedule);
    this.setSchedule();
  }

  // handler the schedule store can call
  deleteSchedule(id: string) {
    this.toSchedule = this.toSchedule.filter((s) => s.id != id);
    this.setSchedule();
  }

  private async init() {
    for await (const schedules of this.schedules.search("*")) {
      this.toSchedule = this.toSchedule.concat(schedules);
    }

    this.setSchedule();
  }

  private setSchedule() {
    // clear timeout
    clearTimeout(this.next);

    // sort array in ascending order by nextRunTime
    this.toSchedule.sort((a, b) => a.nextRunTime - b.nextRunTime);

    if (this.toSchedule.length > 0) {
      // set new timeout to schedule promise
      // + converts to number
      this.next = +setTimeout(() => this.schedulePromise(), this.toSchedule[0].nextRunTime - Date.now());
    }
  }

  private schedulePromise() {
    this.next = undefined;
    const schedule = this.toSchedule.shift();

    if (schedule) {
      const id = this.generatePromiseId(schedule);

      // create promise
      try {
        this.promises.create(
          id,
          id,
          false,
          schedule.promiseParam?.headers,
          schedule.promiseParam?.data,
          Date.now() + schedule.promiseTimeout,
          { ...schedule.promiseTags, "resonate:schedule": schedule.id, "resonate:invocation": "true" },
        );
      } catch (error) {
        this.logger.warn("error creating scheduled promise", error);
      }

      // update schedule
      try {
        this.schedules.update(schedule.id, schedule.nextRunTime);
      } catch (error) {
        this.logger.warn("error updating schedule", error);
      }
    }
  }

  private generatePromiseId(schedule: Schedule): string {
    return schedule.promiseId
      .replace("{{.id}}", schedule.id)
      .replace("{{.timestamp}}", schedule.nextRunTime.toString());
  }

  // Handles all the callbacks
  async handleCallbacks() {
    clearTimeout(this.callbacksTimeout);

    this.callbacksTimeout = setInterval(async () => {
      const callbacksToDelete = [];
      for await (const callbacks of this.callbacks.getAll()) {
        for (const callback of callbacks) {
          const promise = await this.promises.get(callback.id);
          if (isCompletedPromise(promise)) {
            const task = await this.tasks.create(promise.id, callback.data);
            this.tasksSource.emitTask(task);
            callbacksToDelete.push(callback);
          }
        }
      }
      for (const callback of callbacksToDelete) {
        await this.callbacks.delete(callback.id);
      }
    }, 500);
  }
}

export class LocalPromiseStore implements IPromiseStore {
  constructor(
    private store: LocalStore,
    private storage: IStorage<DurablePromiseRecord>,
  ) {}

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
        throw new ResonateError("Forbidden request: Durable promise previously created", ErrorCodes.STORE_FORBIDDEN);
      }

      if (promise.idempotencyKeyForCreate === undefined || ikey !== promise.idempotencyKeyForCreate) {
        throw new ResonateError("Forbidden request: Missing idempotency key for create", ErrorCodes.STORE_FORBIDDEN);
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
    return await this.storage.rmw(id, (promise) => {
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
        throw new ResonateError("Forbidden request", ErrorCodes.STORE_FORBIDDEN);
      }

      if (
        !isTimedoutPromise(promise) &&
        (promise.idempotencyKeyForComplete === undefined || ikey !== promise.idempotencyKeyForComplete)
      ) {
        throw new ResonateError("Forbidden request", ErrorCodes.STORE_FORBIDDEN);
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
        throw new ResonateError("Forbidden request", ErrorCodes.STORE_FORBIDDEN);
      }

      if (
        !isTimedoutPromise(promise) &&
        (promise.idempotencyKeyForComplete === undefined || ikey !== promise.idempotencyKeyForComplete)
      ) {
        throw new ResonateError("Forbidden request", ErrorCodes.STORE_FORBIDDEN);
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
        throw new ResonateError("Forbidden request", ErrorCodes.STORE_FORBIDDEN);
      }

      if (
        !isTimedoutPromise(promise) &&
        (promise.idempotencyKeyForComplete === undefined || ikey !== promise.idempotencyKeyForComplete)
      ) {
        throw new ResonateError("Forbidden request", ErrorCodes.STORE_FORBIDDEN);
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

  async *search(
    id: string,
    state?: string,
    tags?: Record<string, string>,
    limit?: number,
  ): AsyncGenerator<DurablePromiseRecord[], void> {
    //  filter the promises returned from all storage
    const regex = new RegExp(id.replaceAll("*", ".*"));
    const states = searchStates(state);
    const tagEntries = Object.entries(tags ?? {});

    for await (const promises of this.storage.all()) {
      yield promises
        .filter((p) => states.includes(p.state))
        .filter((p) => regex.test(p.id))
        .filter((p) => tagEntries.every(([k, v]) => p.tags?.[k] == v));
    }
  }
}

export class LocalScheduleStore implements IScheduleStore {
  constructor(
    private store: LocalStore,
    private storage: IStorage<Schedule>,
  ) {}

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
        if (schedule.idempotencyKey === undefined || ikey != schedule.idempotencyKey) {
          throw new ResonateError("Already exists", ErrorCodes.STORE_ALREADY_EXISTS);
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

  async *search(id: string, tags?: Record<string, string>, limit?: number): AsyncGenerator<Schedule[], void> {
    // filter the schedules returned from storage
    const regex = new RegExp(id.replaceAll("*", ".*"));
    const tagEntries = Object.entries(tags ?? {});

    for await (const schedules of this.storage.all()) {
      yield schedules.filter((s) => regex.test(s.id)).filter((s) => tagEntries.every(([k, v]) => s.tags?.[k] == v));
    }
  }

  private nextRunTime(cron: string, lastRunTime: number): number {
    return cronParser
      .parseExpression(cron, { currentDate: new Date(lastRunTime) })
      .next()
      .getTime();
  }
}

export class LocalLockStore implements ILockStore {
  constructor(
    private store: LocalStore,
    private storage: IStorage<{ id: string; eid: string }>,
  ) {}

  async tryAcquire(id: string, eid: string): Promise<boolean> {
    const lock = await this.storage.rmw(id, (lock) => {
      if (!lock || lock.eid === eid) {
        return {
          id,
          eid,
        };
      }

      return lock;
    });

    if (lock.eid !== eid) {
      throw new ResonateError("Forbidden request", ErrorCodes.STORE_FORBIDDEN);
    }

    return true;
  }

  async release(id: string, eid: string): Promise<boolean> {
    const result = await this.storage.rmd(id, (lock) => lock.eid === eid);
    if (!result) {
      throw new ResonateError("Not found", ErrorCodes.STORE_NOT_FOUND);
    }

    return true;
  }
}

export class LocalCallbackStore implements ICallbackStore {
  constructor(
    private store: LocalStore,
    private storage: IStorage<{ id: string; data: string }>,
  ) {}

  async create(promiseId: string, recv: string, timeout: number, data: string | undefined): Promise<boolean> {
    await this.storage.rmw(promiseId, (callback) => {
      if (!callback) {
        return {
          id: promiseId,
          data: data ?? "",
        };
      }
    });
    return true;
  }

  async get(promiseId: string): Promise<{ id: string; data: string } | undefined> {
    return this.storage.rmw(promiseId, (callback) => {
      if (callback) return callback;
    });
  }

  getAll(): AsyncGenerator<{ id: string; data: string }[], void, unknown> {
    return this.storage.all();
  }

  async delete(callbackId: string): Promise<boolean> {
    return await this.storage.rmd(callbackId, (callback) => callback.id === callbackId);
  }
}

export class LocalTaskStore implements ITaskStore {
  constructor(
    private store: LocalStore,
    private storage: IStorage<{ id: string; counter: number; data: string }>,
  ) {}

  create(taskId: string, data: string): Promise<{ id: string; counter: number }> {
    return this.storage.rmw(taskId, (task) => {
      return task ? task : { id: taskId, counter: 0, data: data };
    });
  }

  async claim(taskId: string, count: number): Promise<ResumeBody> {
    const task = await this.storage.rmw(taskId, (task) => {
      if (task) {
        return task;
      }
    });
    if (!task) {
      throw new ResonateError("Task not found", ErrorCodes.STORE_NOT_FOUND);
    }

    const resumeBody = JSON.parse(task.data);
    if (!isResumeBody(resumeBody)) {
      throw new ResonateError("Invalid response", ErrorCodes.STORE_PAYLOAD, resumeBody);
    }
    return resumeBody;
  }

  complete(taskId: string, count: number): Promise<boolean> {
    return this.storage.rmd(taskId, (task) => task.id === taskId);
  }
}

// Utils

function searchStates(state: string | undefined): string[] {
  if (state?.toLowerCase() == "pending") {
    return ["PENDING"];
  } else if (state?.toLowerCase() == "resolved") {
    return ["RESOLVED"];
  } else if (state?.toLowerCase() == "rejected") {
    return ["REJECTED", "REJECTED_CANCELED", "REJECTED_TIMEDOUT"];
  } else {
    return ["PENDING", "RESOLVED", "REJECTED", "REJECTED_CANCELED", "REJECTED_TIMEDOUT"];
  }
}
