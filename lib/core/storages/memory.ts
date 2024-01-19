import { IPromiseStorage, IScheduleStorage } from "../storage";
import { DurablePromise } from "../promise";
import { Schedule } from "../schedule";

export class MemoryPromiseStorage implements IPromiseStorage {
  private promises: Record<string, DurablePromise> = {};
  constructor() {}

  async rmw<P extends DurablePromise | undefined>(id: string, f: (item: DurablePromise | undefined) => P): Promise<P> {
    const item = f(this.promises[id]);
    if (item) {
      if ("state" in item) {
        this.promises[id] = item as DurablePromise;
      }
    }

    return item;
  }

  async *search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<DurablePromise[], void> {
    yield Object.values(this.promises);
  }
}

export class MemoryScheduleStorage implements IScheduleStorage {
  private schedules: Record<string, Schedule> = {};

  constructor() {}

  async rmw<P extends Schedule | undefined>(id: string, f: (item: Schedule | undefined) => P): Promise<P> {
    const item = f(this.schedules[id]);
    if (item) {
      this.schedules[id] = item as Schedule;
    }

    return item;
  }

  async *search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<Schedule[], void> {
    yield Object.values(this.schedules);
  }

  async delete(id: string): Promise<boolean> {
    try {
      delete this.schedules[id];
      return true;
    } catch (e) {
      return false;
    }
  }
}

export class MemoryStorage {
  private promiseStorage: IPromiseStorage;
  private scheduleStorage: IScheduleStorage;

  constructor() {
    this.promiseStorage = new MemoryPromiseStorage();
    this.scheduleStorage = new MemoryScheduleStorage();
  }

  get promises(): IPromiseStorage {
    return this.promiseStorage;
  }

  get schedules(): IScheduleStorage {
    return this.scheduleStorage;
  }
}
