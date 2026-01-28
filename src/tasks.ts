import { LocalNetwork } from "../dev/network";
import type { Network, PromiseRecord, TaskAcquireRes } from "./network/network";
import * as util from "./util";

export class Tasks {
  private network: Network;

  constructor(network: Network = new LocalNetwork()) {
    this.network = network;
  }

  acquire(id: string, version: number, pid: string, ttl: number): Promise<TaskAcquireRes["data"]> {
    return new Promise((resolve, reject) => {
      this.network.send(
        {
          kind: "task.acquire",
          head: { corrId: "", version: "" },
          data: {
            id,
            version,
            pid,
            ttl,
          },
        },
        (res) => {
          if (res.kind === "error") {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          util.assert(res.kind === "task.acquire");
          resolve(res.data);
        },
      );
    });
  }

  fulfill(id: string, version: number): Promise<PromiseRecord<string>> {
    return new Promise((resolve, reject) => {
      this.network.send(
        {
          kind: "task.fulfill",
          head: { corrId: "", version: "" },
          data: {
            id,
            version,
            action: {
              kind: "promise.settle",
              head: { corrId: "", version: "" },
              data: { id, state: "rejected", value: { headers: {}, data: "" } },
            },
          },
        },
        (res) => {
          if (res.kind === "error") {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          util.assert(res.kind === "task.fulfill");
          resolve(res.data.promise);
        },
      );
    });
  }

  heartbeat(pid: string): Promise<undefined> {
    return new Promise((resolve, reject) => {
      this.network.send(
        {
          kind: "task.heartbeat",
          head: { corrId: "", version: "" },
          data: {
            pid,
            tasks: [],
          },
        },
        (res) => {
          if (res.kind === "error") {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          util.assert(res.kind === "task.heartbeat");
          resolve(res.data);
        },
      );
    });
  }
}
