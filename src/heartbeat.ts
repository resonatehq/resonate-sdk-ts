import { assert } from "@resonatehq/dev";
import type { Network } from "./network/network";

export interface Heartbeat {
  start(): void;
  stop(): void;
}

export class AsyncHeartbeat implements Heartbeat {
  private network: Network;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private pid: string;
  private counter = 0;
  private delay: number;

  constructor(pid: string, delay: number, network: Network) {
    this.pid = pid;
    this.delay = delay;
    this.network = network;
  }

  start(): void {
    this.counter++;
    if (!this.intervalId) {
      this.heartbeat();
    }
  }

  private heartbeat(): void {
    this.intervalId = setInterval(() => {
      const counter = this.counter;
      const corrId = crypto.randomUUID();
      this.network.send(
        {
          kind: "task.heartbeat",
          head: { corrId, version: "1" },
          data: { pid: this.pid, tasks: [] },
        },
        (res) => {
          if (res.kind === "error") return;
          assert(res.kind === "task.heartbeat" && res.head.corrId === corrId);
        },
      );
    }, this.delay);
  }

  stop(): void {
    this.clearIntervalIfMatch(this.counter);
  }

  private clearIntervalIfMatch(counter: number) {
    if (this.counter === counter) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}

export class NoopHeartbeat implements Heartbeat {
  start(): void {}
  stop(): void {}
}
