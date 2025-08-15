import type { Network } from "./network/network";

export interface Heartbeat {
  startHeartbeat(delay: number): void;
  stopHeartbeat(): void;
}

export class AsyncHeartbeat implements Heartbeat {
  private network: Network;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private pid: string;

  constructor(network: Network, pid: string) {
    this.network = network;
    this.pid = pid;
  }

  startHeartbeat(delay: number): void {
    if (!this.timeoutId) {
      this.heartbeat(delay);
    }
  }

  private heartbeat(delay: number): void {
    console.log("heartbeating...");
    this.timeoutId = setTimeout(() => {
      this.network.send(
        {
          kind: "heartbeatTasks",
          processId: this.pid,
        },
        (_timeout, response) => {
          if (response.kind === "heartbeatTasks" && response.tasksAffected === 0) {
            this.stopHeartbeat();
            return;
          }

          // Ignore any errors and keep heartbeating
          this.heartbeat(delay);
        },
      );
    }, delay);
  }

  stopHeartbeat(): void {
    clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }
}

export class NoHeartbeat implements Heartbeat {
  startHeartbeat(delay: number): void {}
  stopHeartbeat(): void {}
}
