import { LocalNetwork } from "./network/local.js";
import type { Network } from "./network/network.js";
import { isSuccess, type Request, type Response, type ScheduleRecord } from "./network/types.js";
import { assert } from "./util.js";

export class Schedules {
  private network: Network<Request, Response>;

  constructor(network: Network<Request, Response> = new LocalNetwork()) {
    this.network = network;
  }

  get(id: string): Promise<ScheduleRecord> {
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
          assert(res.kind === "schedule.get");

          if (!isSuccess(res)) {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
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
  ): Promise<ScheduleRecord> {
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
          assert(res.kind === "schedule.create");

          if (!isSuccess(res)) {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
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
          assert(res.kind === "schedule.delete");

          if (!isSuccess(res)) {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          resolve(undefined);
        },
      );
    });
  }
}
