import { LocalNetwork } from "./network/local.js";
import { isSuccess, type ScheduleRecord } from "./network/types.js";
import type { Send } from "./types.js";
import { assert, buildTransport } from "./util.js";

export class Schedules {
  private send: Send;

  constructor(send: Send = buildTransport(new LocalNetwork()).send) {
    this.send = send;
  }

  get(id: string): Promise<ScheduleRecord> {
    return new Promise((resolve, reject) => {
      this.send(
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
      this.send(
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
      this.send(
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
