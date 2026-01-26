import { assert, type ScheduleCreateRes, type ScheduleGetRes } from "@resonatehq/dev";
import { LocalNetwork } from "../dev/network";
import type { Network } from "./network/network";

export class Schedules {
  private network: Network;

  constructor(network: Network = new LocalNetwork()) {
    this.network = network;
  }

  get(id: string): Promise<ScheduleGetRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "schedule.get",
          head: { corrId, version: "1" },
          data: { id },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "schedule.get" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  create(
    id: string,
    cron: string,
    promiseId: string,
    promiseTimeout: number,
    {
      promiseHeaders = undefined,
      promiseData = undefined,
      promiseTags = undefined,
    }: {
      promiseHeaders?: { [key: string]: string };
      promiseData?: string;
      promiseTags?: { [key: string]: string };
    } = {},
  ): Promise<ScheduleCreateRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "schedule.create",
          head: { corrId, version: "1" },
          data: {
            id,
            cron,
            promiseId,
            promiseTimeout,
            promiseParam: { headers: promiseHeaders ?? {}, data: promiseData ?? "" },
            promiseTags: promiseTags ?? {},
          },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "schedule.create" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  delete(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "schedule.delete",
          head: { corrId, version: "1" },
          data: { id },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "schedule.delete" && res.head.corrId === corrId);
          resolve();
        },
      );
    });
  }
}
