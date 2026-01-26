import {
  assert,
  type PromiseCreateRes,
  type PromiseGetRes,
  type PromiseRegisterRes,
  type PromiseSettleRes,
  type PromiseSubscribeRes,
} from "@resonatehq/dev";
import { LocalNetwork } from "../dev/network";
import type { Network } from "./network/network";

export class Promises {
  private network: Network;
  constructor(network: Network = new LocalNetwork()) {
    this.network = network;
  }

  read(id: string): Promise<PromiseGetRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send({ kind: "promise.get", head: { corrId, version: "1" }, data: { id } }, (res) => {
        if (res.kind === "error") {
          reject(res.data);
          return;
        }
        assert(res.kind === "promise.get" && res.head.corrId === corrId);
        resolve(res.data);
      });
    });
  }

  create(
    id: string,
    timeoutAt: number,
    {
      headers = undefined,
      data = undefined,
      tags = undefined,
    }: {
      headers?: { [key: string]: string };
      data?: string;
      tags?: { [key: string]: string };
    } = {},
  ): Promise<PromiseCreateRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "promise.create",
          head: { corrId, version: "1" },
          data: {
            id,
            timeoutAt,
            param: { headers: headers ?? {}, data: data ?? "" },
            tags: tags ?? {},
          },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "promise.create" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  settle(
    id: string,
    state: "resolved" | "rejected" | "rejected_canceled",
    {
      headers = undefined,
      data = undefined,
    }: {
      headers?: { [key: string]: string };
      data?: string;
    } = {},
  ): Promise<PromiseSettleRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "promise.settle",
          head: { corrId, version: "1" },
          data: {
            id,
            state,
            value: { headers: headers ?? {}, data: data ?? "" },
          },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "promise.settle" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  register(awaiter: string, awaited: string): Promise<PromiseRegisterRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "promise.register",
          head: { corrId, version: "1" },
          data: { awaiter, awaited },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "promise.register" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  subscribe(awaited: string, address: string): Promise<PromiseSubscribeRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "promise.subscribe",
          head: { corrId, version: "1" },
          data: { awaited, address },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "promise.subscribe" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }
}
