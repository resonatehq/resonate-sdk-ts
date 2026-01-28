import { LocalNetwork } from "../dev/network";
import type { Network, ScheduleRecord } from "./network/network";
import * as util from "./util";
export class Schedules {
  private network: Network;

  constructor(network: Network = new LocalNetwork()) {
    this.network = network;
  }

  get(id: string): Promise<ScheduleRecord<string>> {
    return new Promise((resolve, reject) => {
      this.network.send(
        {
          kind: "schedule.get",
          head: { corrId: "", version: "" },
          data: {
            id,
          },
        },
        (res) => {
          if (res.kind === "error") {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          util.assert(res.kind === "schedule.get");

          resolve(res.data.schedule);
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
      promiseHeaders = {},
      promiseData = "",
      promiseTags = {},
    }: {
      description?: string;
      tags?: { [key: string]: string };
      promiseHeaders?: { [key: string]: string };
      promiseData?: string;
      promiseTags?: { [key: string]: string };
    } = {},
  ): Promise<ScheduleRecord<string>> {
    return new Promise((resolve, reject) => {
      this.network.send(
        {
          kind: "schedule.create",
          head: { corrId: "", version: "" },
          data: {
            id: id,
            cron: cron,
            promiseId: promiseId,
            promiseTimeout: promiseTimeout,
            promiseParam: { headers: promiseHeaders, data: promiseData },
            promiseTags: promiseTags,
          },
        },
        (res) => {
          if (res.kind === "error") {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          util.assert(res.kind === "schedule.create");
          resolve(res.data.schedule);
        },
      );
    });
  }

  delete(id: string): Promise<undefined> {
    return new Promise((resolve, reject) => {
      this.network.send(
        {
          kind: "schedule.delete",
          head: { corrId: "", version: "" },
          data: {
            id,
          },
        },
        (res) => {
          if (res.kind === "error") {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          util.assert(res.kind === "schedule.delete");

          resolve(res.data);
        },
      );
    });
  }
}
