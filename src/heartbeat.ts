import type { Send } from "./types.js";

export interface Heartbeat {
  start(): void;
  stop(): void;
}

export class AsyncHeartbeat implements Heartbeat {
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private send: Send;
  private pid: string;
  private counter = 0;
  private delay: number;

  constructor(pid: string, delay: number, send: Send) {
    this.pid = pid;
    this.delay = delay;
    this.send = send;
  }

  start(): void {
    this.counter++;
    if (!this.intervalId) {
      this.heartbeat();
    }
  }

  private heartbeat(): void {
    this.intervalId = setInterval(() => {
      this.send({
        kind: "task.heartbeat",
        head: { corrId: "", version: "" },
        data: {
          pid: this.pid,
          tasks: [],
        },
      }).catch((err) => {
        console.warn("Heartbeat. Failed to send heartbeat:", err);
      });
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
