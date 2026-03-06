import exceptions from "./exceptions.js";
import { LocalNetwork } from "./network/local.js";
import { isSuccess, type PromiseRecord, type TaskAcquireRes } from "./network/types.js";
import type { Send } from "./types.js";
import { buildTransport } from "./util.js";

export class Tasks {
  private send: Send;

  constructor(send: Send = buildTransport(new LocalNetwork()).send) {
    this.send = send;
  }

  async acquire(
    id: string,
    version: number,
    pid: string,
    ttl: number,
  ): Promise<Extract<TaskAcquireRes, { head: { status: 200 } }>["data"]> {
    const res = await this.send({
      kind: "task.acquire",
      head: { corrId: "", version: "" },
      data: {
        id,
        version,
        pid,
        ttl,
      },
    });
    if (!isSuccess(res)) {
      throw exceptions.SERVER_ERROR(res.data, true, {
        code: res.head.status,
        message: res.data,
      });
    }
    return res.data;
  }

  async fulfill(id: string, version: number): Promise<PromiseRecord> {
    const res = await this.send({
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
    });
    if (!isSuccess(res)) {
      throw exceptions.SERVER_ERROR(res.data, true, {
        code: res.head.status,
        message: res.data,
      });
    }
    return res.data.promise;
  }

  async heartbeat(pid: string): Promise<undefined> {
    const res = await this.send({
      kind: "task.heartbeat",
      head: { corrId: "", version: "" },
      data: {
        pid,
        tasks: [],
      },
    });
    if (!isSuccess(res)) {
      throw exceptions.SERVER_ERROR(res.data, true, {
        code: res.head.status,
        message: res.data,
      });
    }
    return undefined;
  }
}
