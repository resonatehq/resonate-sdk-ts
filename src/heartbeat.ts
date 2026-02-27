import type { Request, Response } from "./essential.js";
import type { Network } from "./network/network.js";

export interface Heartbeat {
  start(): void;
  stop(): void;
}

export class AsyncHeartbeat implements Heartbeat {
  private network: Network<Request, Response>;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private pid: string;
  private counter = 0;
  private delay: number;

  constructor(pid: string, delay: number, network: Network<Request, Response>) {
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

      this.network.send(
        {
          kind: "task.heartbeat",
          head: { corrId: "", version: "" },
          data: {
            pid: this.pid,
            tasks: [],
          },
        },
        (res) => {
          return;
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
