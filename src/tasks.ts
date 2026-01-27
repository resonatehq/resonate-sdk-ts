import {
  assert,
  type PromiseCreateReq,
  type PromiseRegisterReq,
  type PromiseSettleReq,
  type TaskAcquireRes,
  type TaskCreateRes,
  type TaskFenceRes,
  type TaskFulfillRes,
  type TaskGetRes,
  type TaskSuspendRes,
} from "@resonatehq/dev";
import { LocalNetwork } from "../dev/network";
import type { Network } from "./network/network";

export class Tasks {
  private network: Network;

  constructor(network: Network = new LocalNetwork()) {
    this.network = network;
  }

  get(id: string): Promise<TaskGetRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.get",
          head: { corrId, version: "1" },
          data: { id },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.get" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  create(pid: string, ttl: number, action: PromiseCreateReq): Promise<TaskCreateRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.create",
          head: { corrId, version: "1" },
          data: { pid, ttl, action },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.create" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  acquire(id: string, version: number, pid: string, ttl: number): Promise<TaskAcquireRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.acquire",
          head: { corrId, version: "1" },
          data: { id, version, pid, ttl },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.acquire" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  suspend(id: string, version: number, actions: PromiseRegisterReq[]): Promise<TaskSuspendRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.suspend",
          head: { corrId, version: "1" },
          data: { id, version, actions },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.suspend" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  fulfill(id: string, version: number, action: PromiseSettleReq): Promise<TaskFulfillRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.fulfill",
          head: { corrId, version: "1" },
          data: { id, version, action },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.fulfill" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  release(id: string, version: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.release",
          head: { corrId, version: "1" },
          data: { id, version },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.release" && res.head.corrId === corrId);
          resolve();
        },
      );
    });
  }

  fence(id: string, version: number, action: PromiseCreateReq | PromiseSettleReq): Promise<TaskFenceRes["data"]> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.fence",
          head: { corrId, version: "1" },
          data: { id, version, action },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.fence" && res.head.corrId === corrId);
          resolve(res.data);
        },
      );
    });
  }

  heartbeat(pid: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.heartbeat",
          head: { corrId, version: "1" },
          data: { pid, tasks: [] },
        },
        (res) => {
          if (res.kind === "error") {
            reject(res.data);
            return;
          }
          assert(res.kind === "task.heartbeat" && res.head.corrId === corrId);
          resolve();
        },
      );
    });
  }
}
