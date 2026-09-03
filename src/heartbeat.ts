import type { Logger } from "./logger.js";
import { randomUUID } from "./platform.js";
import type { Send } from "./types.js";
import { VERSION } from "./util.js";

export type HeartbeatTask = {
  id: string;
  version: number;
};

export interface Heartbeat {
  /** Track an acquired task, or start the heartbeat lifecycle for compatibility. */
  start(task?: HeartbeatTask): void;
  /** Stop tracking a task, or stop the heartbeat lifecycle entirely. */
  stop(task?: HeartbeatTask): void;
}

export class AsyncHeartbeat implements Heartbeat {
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private send: Send;
  private pid: string;
  private tasks = new Map<string, HeartbeatTask>();
  private delay: number;
  private logger: Logger;

  constructor(pid: string, delay: number, send: Send, logger: Logger) {
    this.pid = pid;
    this.delay = delay;
    this.send = send;
    this.logger = logger;
  }

  start(task?: HeartbeatTask): void {
    if (!task) return;

    this.tasks.set(task.id, task);
    if (!this.intervalId) {
      this.heartbeat();
    }
  }

  private heartbeat(): void {
    this.intervalId = setInterval(() => {
      for (const task of this.tasks.values()) {
        this.send({
          kind: "task.heartbeat",
          head: { corrId: randomUUID(), version: VERSION },
          data: {
            pid: this.pid,
            // Heartbeats are sent one task at a time because the server routes
            // a batch by origin and requires every task in it to share one.
            tasks: [task],
          },
        }).catch((err) => {
          this.logger.warn(
            {
              component: "heartbeat",
              pid: this.pid,
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            },
            "Failed to send heartbeat",
          );
        });
      }
    }, this.delay);
  }

  stop(task?: HeartbeatTask): void {
    if (task) {
      const tracked = this.tasks.get(task.id);
      if (tracked?.version === task.version) {
        this.tasks.delete(task.id);
      }
    } else {
      this.tasks.clear();
    }

    if (this.tasks.size === 0) {
      this.clearInterval();
    }
  }

  private clearInterval() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}

export class NoopHeartbeat implements Heartbeat {
  start(_task?: HeartbeatTask): void {}
  stop(_task?: HeartbeatTask): void {}
}
