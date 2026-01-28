import { LocalNetwork } from "../dev/network";
import type { Network, PromiseRecord, TaskRecord } from "./network/network";

import * as util from "./util";
export class Promises {
  private network: Network;
  constructor(network: Network = new LocalNetwork()) {
    this.network = network;
  }

  get(id: string): Promise<PromiseRecord<string>> {
    return new Promise((resolve, reject) => {
      this.network.send({ kind: "promise.get", head: { corrId: "", version: "" }, data: { id } }, (res) => {
        if (res.kind === "error") {
          reject(res.data);
          return;
        }
        util.assert(res.kind === "promise.get");
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
  ): Promise<PromiseRecord<string>> {
    return new Promise((resolve, reject) => {
      this.network.send(
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
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          util.assert(res.kind === "promise.create");
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
  ): Promise<{ promise: PromiseRecord<string>; task?: TaskRecord }> {
    return new Promise((resolve, reject) => {
      this.network.send(
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
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          util.assert(res.kind === "task.create");
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
  ): Promise<PromiseRecord<string>> {
    return new Promise((resolve, reject) => {
      this.network.send(
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
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          util.assert(res.kind === "promise.settle");
          resolve(res.data.promise);
        },
      );
    });
  }
  register(
    awaited: string,
    awaiter: string,
  ): Promise<{
    promise: PromiseRecord<string>;
  }> {
    return new Promise((resolve, reject) => {
      this.network.send(
        {
          kind: "promise.register",
          head: { corrId: "", version: "" },
          data: { awaited, awaiter },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          util.assert(res.kind === "promise.register");
          resolve({ promise: res.data.promise });
        },
      );
    });
  }

  subscribe(
    awaited: string,
    address: string,
  ): Promise<{
    promise: PromiseRecord<string>;
  }> {
    return new Promise((resolve, reject) => {
      this.network.send(
        { kind: "promise.subscribe", head: { corrId: "", version: "" }, data: { awaited, address } },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }

          util.assert(res.kind === "promise.subscribe");
          resolve({ promise: res.data.promise });
        },
      );
    });
  }
}
