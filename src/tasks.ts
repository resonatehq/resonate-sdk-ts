import { LocalNetwork } from "./network/local.js";
import type { Network } from "./network/network.js";
import {
  isTaskAcquireRes200,
  isTaskFulfillRes200,
  isTaskHeartbeatRes200,
  type PromiseRecord,
  type TaskAcquireRes200,
} from "./network/types.js";

export class Tasks {
  private network: Network;

  constructor(network: Network = new LocalNetwork()) {
    this.network = network;
  }

  acquire(id: string, version: number, pid: string, ttl: number): Promise<TaskAcquireRes200["data"]> {
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
          if (!isTaskAcquireRes200(res)) {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
          resolve(res.data);
        },
      );
    });
  }

  fulfill(id: string, version: number): Promise<PromiseRecord> {
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
          if (!isTaskFulfillRes200(res)) {
            // TODO: reject with more information
            reject(Error("not implemented"));
            return;
          }
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
          if (!isTaskHeartbeatRes200(res)) {
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
