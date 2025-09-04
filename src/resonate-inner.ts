import type { Clock } from "./clock";
import { Computation, type Status } from "./computation";
import type { Handler } from "./handler";
import type { Heartbeat } from "./heartbeat";
import type {
  CreatePromiseAndTaskReq,
  CreatePromiseReq,
  DurablePromiseRecord,
  Message,
  Network,
  ReadPromiseReq,
  TaskRecord,
} from "./network/network";
import type { Registry } from "./registry";
import type { Callback } from "./types";
import * as util from "./util";

export type PromiseHandler = {
  addEventListener: (event: "created" | "completed", callback: (p: DurablePromiseRecord) => void) => void;
  subscribe: () => Promise<void>;
};

export type Task = ClaimedTask | UnclaimedTask;

export type ClaimedTask = {
  kind: "claimed";
  task: TaskRecord;
  rootPromise: DurablePromiseRecord;
};

export type UnclaimedTask = {
  kind: "unclaimed";
  task: TaskRecord;
};

export class ResonateInner {
  private unicast: string;
  private anycast: string;
  private pid: string;
  private ttl: number;
  private clock: Clock;
  private network: Network;
  private handler: Handler;
  private registry: Registry;
  private heartbeat: Heartbeat;
  private dependencies: Map<string, any>;

  private computations: Map<string, Computation> = new Map();
  private notifications: Map<string, DurablePromiseRecord> = new Map();
  private subscriptions: Map<string, Array<(promise: DurablePromiseRecord) => boolean>> = new Map();

  constructor({
    unicast,
    anycast,
    pid,
    ttl,
    clock,
    network,
    handler,
    registry,
    heartbeat,
    dependencies,
  }: {
    unicast: string;
    anycast: string;
    pid: string;
    ttl: number;
    clock: Clock;
    network: Network;
    handler: Handler;
    registry: Registry;
    heartbeat: Heartbeat;
    dependencies: Map<string, any>;
  }) {
    this.unicast = unicast;
    this.anycast = anycast;
    this.pid = pid;
    this.ttl = ttl;
    this.clock = clock;
    this.network = network;
    this.handler = handler;
    this.registry = registry;
    this.heartbeat = heartbeat;
    this.dependencies = dependencies;

    // subscribe to network messages
    this.network.subscribe(this.onMessage.bind(this));
  }

  public run(req: CreatePromiseAndTaskReq): Promise<PromiseHandler> {
    return new Promise((resolve, reject) => {
      this.handler.createPromiseAndTask(
        req,
        (err, res) => {
          if (err) {
            reject(err);
          } else {
            // notify
            this.notify(res!.promise);

            // if we have the task, process it
            if (res!.task) {
              this.process({ kind: "claimed", task: res!.task, rootPromise: res!.promise }, () => {});
            }

            // resolve
            resolve(this.promiseHandler(res!.promise.id, res!.promise.timeout));
          }
        },
        true,
      );
    });
  }

  public rpc(req: CreatePromiseReq): Promise<PromiseHandler> {
    return new Promise((resolve, reject) => {
      this.handler.createPromise(
        req,
        (err, res) => {
          if (err) {
            reject(err);
          } else {
            // notify
            this.notify(res!);
            resolve(this.promiseHandler(res!.id, res!.timeout));
          }
        },
        true,
      );
    });
  }

  public get(req: ReadPromiseReq): Promise<PromiseHandler> {
    return new Promise((resolve, reject) => {
      this.handler.readPromise(req, (err, res) => {
        if (err) {
          reject(err);
        } else {
          // huh?
          this.notify(res!);
          resolve(this.promiseHandler(res!.id, res!.timeout));
        }
      });
    });
  }

  public process(task: Task, done: Callback<Status>) {
    let computation = this.computations.get(task.task.rootPromiseId);
    if (!computation) {
      computation = new Computation(
        task.task.rootPromiseId,
        this.unicast,
        this.anycast,
        this.pid,
        this.ttl,
        this.clock,
        this.network,
        this.handler,
        this.registry,
        this.heartbeat,
        this.dependencies,
      );
      this.computations.set(task.task.rootPromiseId, computation);
    }

    computation.process(task, done);
  }

  private promiseHandler(id: string, timeout: number): PromiseHandler {
    return {
      addEventListener: (event: "created" | "completed", callback: (p: DurablePromiseRecord) => void) => {
        const subscriptions = this.subscriptions.get(id) || [];

        subscriptions.push((p: DurablePromiseRecord): boolean => {
          if (event === "created" || (event === "completed" && p.state !== "pending")) {
            callback(p);
            return true;
          }

          return false;
        });

        this.subscriptions.set(id, subscriptions);

        // immediately notify if we already have a promise
        const promise = this.notifications.get(id);
        if (promise) {
          this.notify(promise);
        }
      },
      subscribe: () =>
        new Promise<void>((resolve, reject) => {
          this.handler.createSubscription(
            {
              kind: "createSubscription",
              id: id,
              timeout: timeout + 1 * util.MIN, // add a buffer
              recv: this.unicast,
            },
            (err, res) => {
              if (err) {
                reject(err);
              } else {
                this.notify(res!);
                resolve();
              }
            },
            true,
          );
        }),
    };
  }

  private onMessage(msg: Message): void {
    switch (msg.type) {
      case "invoke":
      case "resume":
        this.process({ kind: "unclaimed", task: msg.task }, () => {});
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
}
