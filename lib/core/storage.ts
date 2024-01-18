import { DurablePromise, TimedoutPromise, isDurablePromise, isPendingPromise } from "./promise";
import { Schedule, isSchedule } from "./schedule";

export interface IPromiseStorage {
  rmw<P extends DurablePromise | undefined>(id: string, f: (promise: DurablePromise | undefined) => P): Promise<P>;
  search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<DurablePromise[], void>;
}

export interface IScheduleStorage {
  rmw<P extends Schedule | undefined>(id: string, f: (schedule: Schedule | undefined) => P): Promise<P>;
  search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<Schedule[], void>;

  deleteSchedule(id: string): Promise<boolean>;
}

export class WithTimeout implements IPromiseStorage {
  constructor(private storage: IPromiseStorage) {}

  rmw<P extends DurablePromise | undefined>(id: string, f: (promise: DurablePromise | undefined) => P): Promise<P> {
    return this.storage.rmw(id, (promise) => f(timeout(promise)));
  }

  async *search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<DurablePromise[], void, unknown> {
    const regex = new RegExp(id.replaceAll("*", ".*"));
    const tagEntries = Object.entries(tags ?? {});

    let states: string[] = [];
    if (state?.toLowerCase() == "pending") {
      states = ["PENDING"];
    } else if (state?.toLowerCase() == "resolved") {
      states = ["RESOLVED"];
    } else if (state?.toLowerCase() == "rejected") {
      states = ["REJECTED", "REJECTED_CANCELED", "REJECTED_TIMEDOUT"];
    } else {
      states = ["PENDING", "RESOLVED", "REJECTED", "REJECTED_CANCELED", "REJECTED_TIMEDOUT"];
    }

    for await (const res of this.storage.search("*", undefined, undefined, limit)) {
      yield res
        .map(timeout)
        .filter(isDurablePromise)
        .filter((promise) => states.includes(promise.state))
        .filter((promise) => regex.test(promise.id))
        .filter((promise) => tagEntries.every(([k, v]) => promise.tags?.[k] == v));
    }
  }
}

export class WithTimeoutSchedules implements IScheduleStorage {
  constructor(private storage: IScheduleStorage) {}

  rmw<P extends Schedule | undefined>(id: string, f: (schedule: Schedule | undefined) => P): Promise<P> {
    return this.storage.rmw(id, (schedule) => f(schedule));
  }

  async *search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<Schedule[], void, unknown> {
    const regex = new RegExp(id.replaceAll("*", ".*"));
    const tagEntries = Object.entries(tags ?? {});

    for await (const res of this.storage.search("*", undefined, undefined, undefined)) {
      yield res;
    }
  }

  deleteSchedule(id: string): Promise<boolean> {
    return this.storage.deleteSchedule(id);
  }
}

function timeout<P extends DurablePromise | Schedule | undefined>(promise: P): P | TimedoutPromise {
  if (isPendingPromise(promise) && Date.now() >= promise.timeout) {
    return {
      state: "REJECTED_TIMEDOUT",
      id: promise.id,
      timeout: promise.timeout,
      param: promise.param,
      value: {
        headers: undefined,
        data: undefined,
      },
      createdOn: promise.createdOn,
      completedOn: promise.timeout,
      idempotencyKeyForCreate: promise.idempotencyKeyForCreate,
      idempotencyKeyForComplete: undefined,
      tags: promise.tags,
    };
  }

  return promise;
}
