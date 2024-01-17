import { IStorage } from "../storage";
import { DurablePromise } from "../promise";
import { Schedule } from "../schedule";

export class MemoryStorage implements IStorage {
  private promises: Record<string, DurablePromise> = {};
  private schedules: Record<string, Schedule> = {};

  constructor() {}

  async rmw<P extends DurablePromise | Schedule | undefined>(
    id: string,
    f: (item: DurablePromise | Schedule | undefined) => P,
  ): Promise<P> {
    const item = f(this.promises[id] || this.schedules[id]);
    if (item) {
      if ("state" in item) {
        this.promises[id] = item as DurablePromise;
      } else {
        this.schedules[id] = item as Schedule;
      }
    }

    return item;
  }

  async *search(
    id: string,
    type: string | undefined,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<(DurablePromise | Schedule)[], void> {
    if (type === undefined || type.toLowerCase() === "schedules") {
      yield Object.values(this.schedules);
    } else if (type.toLowerCase() === "promises") {
      yield Object.values(this.promises);
    } else {
      throw new Error(`Invalid type ${type}`);
    }
  }

  async deleteSchedule(id: string): Promise<boolean> {
    try {
      delete this.schedules[id];
      return true;
    } catch (e) {
      return false;
    }
  }
}
