import { Computation, type Status } from "./computation";
import type { Heartbeat } from "./heartbeat";
import type {
  CreatePromiseAndTaskReq,
  CreatePromiseReq,
  DurablePromiseRecord,
  Message,
  Network,
} from "./network/network";
import { Registry } from "./registry";
import type { Callback, Func, Task } from "./types";
import * as util from "./util";

export type Run = {
  kind: "run";
  id: string;
  req: CreatePromiseAndTaskReq;
};

export type Rpc = {
  kind: "rpc";
  id: string;
  req: CreatePromiseReq;
};

export type PromiseHandler = {
  addEventListener: (event: "created" | "completed", callback: (p: DurablePromiseRecord) => void) => void;
  subscribe: () => Promise<void>;
};

export class ResonateInner {
  public registry: Registry; // TODO(avillega): Who should own the registry? the resonate class?

  private computations: Map<string, Computation>;
  private network: Network;
  private group: string;
  private pid: string;
  private ttl: number;
  private heartbeat: Heartbeat;
  private notifications: Map<string, DurablePromiseRecord> = new Map();
  private subscriptions: Map<string, Array<(promise: DurablePromiseRecord) => boolean>> = new Map();

  constructor(network: Network, config: { group: string; pid: string; ttl: number; heartbeat: Heartbeat }) {
    const { group, pid, ttl, heartbeat } = config;
    this.computations = new Map();
    this.group = group;
    this.pid = pid;
    this.ttl = ttl;
    this.heartbeat = heartbeat;
    this.registry = new Registry();
    this.network = network;
    this.network.subscribe(this.onMessage.bind(this));
  }

  public process(cmd: Run | Rpc): PromiseHandler {
    const promiseHandler = {
      addEventListener: (event: "created" | "completed", callback: (p: DurablePromiseRecord) => void) => {
        const subscriptions = this.subscriptions.get(cmd.id) || [];

        subscriptions.push((p: DurablePromiseRecord): boolean => {
          if (event === "created" || (event === "completed" && p.state !== "pending")) {
            callback(p);
            return true;
          }

          return false;
        });

        this.subscriptions.set(cmd.id, subscriptions);
      },
      subscribe: () =>
        new Promise<void>((resolve) => {
          // attempt to subscribe forever
          this.network.send(
            {
              kind: "createSubscription",
              id: cmd.id,
              timeout: cmd.kind === "run" ? cmd.req.promise.timeout : cmd.req.timeout,
              recv: `poll://uni@${this.group}/${this.pid}`,
            },
            (err, res) => {
              util.assert(!err, "retry forever ensures err is false");
              util.assertDefined(res);

              this.notify(res.promise);
              resolve();
            },
            true,
          );
        }),
    };

    this.network.send(
      cmd.req,
      (err, res) => {
        util.assert(!err, "retry forever ensures err is false");
        util.assertDefined(res);

        // notify created
        this.notify(res.promise);

        // process if we have the task
        if (res.kind === "createPromiseAndTask" && res.task) {
          this.processTask(
            {
              ...res.task,
              rootPromise: res.promise,
              kind: "claimed",
            },
            (err, res) => {
              if (err) {
                // the task has already been dropped, just subscribe
                promiseHandler.subscribe();
                return;
              }
              util.assertDefined(res);

              if (res.kind === "suspended") {
                // do we need to do anything here?
              } else {
                // notify subscribers of the completed promise
                this.notify(res.promise);
              }
            },
          );
        }
      },
      true,
    );

    return promiseHandler;
  }

  private processTask(task: Task, done: Callback<Status>) {
    let computation = this.computations.get(task.rootPromiseId);
    if (!computation) {
      computation = new Computation(
        task.rootPromiseId,
        this.pid,
        this.ttl,
        this.group,
        this.network,
        this.registry,
        this.heartbeat,
      );
      this.computations.set(task.rootPromiseId, computation);
    }

    computation.process(task, done);
  }

  public register<F extends Func>(name: string, func: F) {
    if (this.registry.has(name)) {
      throw new Error(`'${name}' already registered`);
    }

    this.registry.set(name, func);
  }

  private onMessage(msg: Message): void {
    switch (msg.type) {
      case "invoke":
      case "resume":
        this.processTask({ ...msg.task, kind: "unclaimed" }, () => {});
        break;

      case "notify":
        // TODO(avillega): assert that the promise is completed
        this.notify(msg.promise);
        break;
    }
  }

  private notify(promise: DurablePromiseRecord) {
    // store the notification
    this.notifications.set(promise.id, promise);

    // notify subscribers
    const subscriptions = this.subscriptions.get(promise.id) ?? [];
    for (const [i, f] of subscriptions.entries()) {
      if (f(promise)) {
        subscriptions.splice(i, 1);
      }
    }

    // remove any subscriber that was notified
    this.subscriptions.set(promise.id, subscriptions);
  }

  public stop() {
    this.network.stop();
    this.heartbeat.stop();
  }
}
