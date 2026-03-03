import { LocalNetwork } from "./network/local.js";
import { isSuccess, type PromiseRecord, type TaskRecord } from "./network/types.js";
import type { Send } from "./types.js";
import { buildTransport } from "./util.js";

export class Promises {
  private send: Send;
  constructor(send: Send = buildTransport(new LocalNetwork()).send) {
    this.send = send;
  }

  get(id: string): Promise<PromiseRecord> {
    return new Promise((resolve, reject) => {
      this.send({ kind: "promise.get", head: { corrId: "", version: "" }, data: { id } }, (res) => {
        if (!isSuccess(res)) {
          reject(res.data);
          return;
        }
        resolve(res.data.promise);
      });
    });
  }

  create(
    id: string,
    timeoutAt: number,
    {
      headers = {},
      data = "",
      tags = {},
    }: {
      headers?: { [key: string]: string };
      data?: string;
      tags?: { [key: string]: string };
    } = {},
  ): Promise<PromiseRecord> {
    return new Promise((resolve, reject) => {
      this.send(
        {
          kind: "promise.create",
          head: { corrId: "", version: "" },
          data: {
            id,
            timeoutAt,
            param: { headers, data },
            tags,
          },
        },
        (res) => {
          if (!isSuccess(res)) {
            reject(res.data);
            return;
          }
          resolve(res.data.promise);
        },
      );
    });
  }

  createWithTask(
    id: string,
    timeoutAt: number,
    pid: string,
    ttl: number,
    {
      headers = {},
      data = "",
      tags = {},
    }: {
      headers?: { [key: string]: string };
      data?: string;
      tags?: { [key: string]: string };
    } = {},
  ): Promise<{ promise: PromiseRecord; task?: TaskRecord }> {
    return new Promise((resolve, reject) => {
      this.send(
        {
          kind: "task.create",
          head: { corrId: "", version: "" },
          data: {
            pid,
            ttl,
            action: {
              kind: "promise.create",
              head: { corrId: "", version: "" },
              data: { id, timeoutAt, param: { headers, data }, tags },
            },
          },
        },
        (res) => {
          if (!isSuccess(res)) {
            reject(res.data);
            return;
          }
          resolve({ promise: res.data.promise, task: res.data.task });
        },
      );
    });
  }

  settle(
    id: string,
    state: "resolved" | "rejected" | "rejected_canceled",
    {
      headers = {},
      data = "",
    }: {
      headers?: { [key: string]: string };
      data?: string;
    } = {},
  ): Promise<PromiseRecord> {
    return new Promise((resolve, reject) => {
      this.send(
        {
          kind: "promise.settle",
          head: { corrId: "", version: "" },
          data: {
            id,
            state,
            value: { headers, data },
          },
        },
        (res) => {
          if (!isSuccess(res)) {
            reject(res.data);
            return;
          }
          resolve(res.data.promise);
        },
      );
    });
  }
  registerCallback(
    awaited: string,
    awaiter: string,
  ): Promise<{
    promise: PromiseRecord;
  }> {
    return new Promise((resolve, reject) => {
      this.send(
        {
          kind: "promise.register_callback",
          head: { corrId: "", version: "" },
          data: { awaited, awaiter },
        },
        (res) => {
          if (!isSuccess(res)) {
            reject(res.data);
            return;
          }
          resolve({ promise: res.data.promise });
        },
      );
    });
  }

  registerListener(
    awaited: string,
    address: string,
  ): Promise<{
    promise: PromiseRecord;
  }> {
    return new Promise((resolve, reject) => {
      this.send(
        { kind: "promise.register_listener", head: { corrId: "", version: "" }, data: { awaited, address } },
        (res) => {
          if (!isSuccess(res)) {
            reject(res.data);
            return;
          }
          resolve({ promise: res.data.promise });
        },
      );
    });
  }
}
