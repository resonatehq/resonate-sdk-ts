import type { Server as HttpServer } from "node:http";
import KoaRouter from "@koa/router";
import Koa, { type Context } from "koa";
import bodyParser from "koa-bodyparser";
import type { ResonateError } from "../src/exceptions";
import type { Message, MessageSource, Network, Request, ResponseFor } from "../src/network/network";
import * as util from "../src/util";
import { Server } from "./server";

export class LocalMessageSource implements MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;
  private server: Server;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private shouldStop = false;
  private subscriptions: {
    invoke: Array<(msg: Message) => void>;
    resume: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { invoke: [], resume: [], notify: [] };

  constructor(pid: string, group: string, server: Server) {
    this.pid = pid;
    this.group = group;
    this.unicast = `poll://uni@${group}/${pid}`;
    this.anycast = `poll://any@${group}/${pid}`;
    this.server = server;
    this.timeoutId = undefined;
  }

  stop() {
    clearTimeout(this.timeoutId);
    this.shouldStop = true;
    this.timeoutId = undefined;
  }

  recv(msg: Message): void {
    for (const callback of this.subscriptions[msg.type]) {
      callback(msg);
    }
  }

  subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }

  enqueueNext(): void {
    clearTimeout(this.timeoutId);

    const time = Date.now();
    const next = this.server.next(time);

    if (next !== undefined && !this.shouldStop) {
      this.timeoutId = setTimeout((): void => {
        for (const { msg } of this.server.step(time)) {
          this.recv(msg);
        }
        this.enqueueNext();
      }, next);
    }
  }

  match(target: string): string {
    return `poll://any@${target}`;
  }
}

export interface LocalNetworkConfig {
  pid?: string;
  group?: string;
  server?: Server;
}

const koa = new Koa();

export class LocalNetwork implements Network {
  private server: Server;
  private messageSource: LocalMessageSource;
  private webapp: HttpServer | undefined = undefined;

  constructor({ pid = "pid", group = "default", server = new Server() }: LocalNetworkConfig = {}) {
    this.server = server;
    this.messageSource = new LocalMessageSource(pid, group, server);

    const router = this.initializeRoutes(new KoaRouter());
    koa.use(bodyParser());
    koa.use(router.routes());
    koa.use(router.allowedMethods());
  }

  private sendPromised(message: Request): Promise<ResponseFor<Request>> {
    return new Promise((resolve, reject) => {
      // The original this.send call
      this.send(message, (err, res) => {
        if (err !== undefined) {
          // If there's an error, reject the Promise
          reject(err);
        } else {
          util.assertDefined(res);
          resolve(res);
        }
      });
    });
  }

  private initializeRoutes(router: KoaRouter): KoaRouter {
    router.get("/promises", async (ctx: Context) => {
      const res = await this.sendPromised({ kind: "searchPromises", id: ctx.query.id as string });
      if (res.kind !== "searchPromises") {
        util.assert(false, "unreacheable");
        return;
      }
      ctx.status = 200;
      ctx.type = "application/json";
      ctx.body = { promises: res.promises };
    });

    router.post("/promises", async (ctx: Context) => {
      const { id, param, tags, timeout } = ctx.request.body as {
        id: string;
        param: any;
        tags: Record<string, string>;
        timeout: number;
      };
      const res = await this.sendPromised({
        kind: "createPromise",
        id,
        param,
        tags,
        timeout,
        strict: (ctx.request.headers.strict as string) === "true",
        iKey: ctx.request.headers["idempotency-key"] as string,
      });
      if (res.kind !== "createPromise") {
        util.panic("unreachable");
        return;
      }
      ctx.status = 201;
      ctx.type = "application/json";
      ctx.body = res.promise;
    });

    router.post("/promises/task", async (ctx: Context) => {
      const { promise, task } = ctx.request.body as {
        promise: { id: string; timeout: number; param: any; tags: Record<string, string> };
        task: { processId: string; ttl: number };
      };
      const res = await this.sendPromised({
        kind: "createPromiseAndTask",
        promise,
        task,
        iKey: ctx.request.headers["idempotency-key"] as string,
        strict: (ctx.request.headers.strict as string) === "true",
      });

      if (res.kind !== "createPromiseAndTask") {
        util.panic("unreachable");
        return;
      }
      ctx.type = "application/json";
      ctx.status = res.task === undefined ? 200 : 201;
      ctx.body = { promise: res.promise, task: res.task };
    });

    router.get("/promises/:id", async (ctx: Context) => {
      const res = await this.sendPromised({ kind: "readPromise", id: ctx.params.id as string });
      if (res.kind !== "readPromise") {
        util.panic("unreachable");
        return;
      }
      ctx.status = 200;
      ctx.type = "application/json";
      ctx.body = res.promise;
    });

    router.patch("/promises/:id", async (ctx: Context) => {
      const { state, value } = ctx.request.body as {
        state: string;
        value: any;
      };
      const res = await this.sendPromised({
        kind: "completePromise",
        id: ctx.params.id as string,
        state: state.toLowerCase() as "resolved" | "rejected" | "rejected_canceled",
        value,
        iKey: ctx.request.headers["idempotency-key"] as string,
        strict: (ctx.request.headers.strict as string) === "true",
      });

      if (res.kind !== "completePromise") {
        util.panic("unreachable");
        return;
      }

      ctx.status = 200;
      ctx.type = "application/json";
      ctx.body = res.promise;
    });

    router.post("/promises/callback/:id", async (ctx: Context) => {
      const promiseId = ctx.params.id as string;
      const { rootPromiseId, timeout, recv } = ctx.request.body as {
        rootPromiseId: string;
        timeout: number;
        recv: string;
      };

      const res = await this.sendPromised({ kind: "createCallback", promiseId, rootPromiseId, timeout, recv });
      if (res.kind !== "createCallback") {
        util.panic("unreachable");
        return;
      }
      ctx.status = 200;
      ctx.type = "application/json";
      ctx.body = { promise: res.promise, callback: res.callback };
    });

    router.post("/promises/subscribe/:id", async (ctx: Context) => {
      const promiseId = ctx.params.id as string;
      const { id, timeout, recv } = ctx.request.body as {
        id: string;
        timeout: number;
        recv: string;
      };
      const res = await this.sendPromised({ kind: "createSubscription", id, promiseId, timeout, recv });
      if (res.kind !== "createSubscription") {
        util.panic("unreachable");
        return;
      }

      ctx.status = res.callback === undefined ? 200 : 201;
      ctx.type = "application/json";
      ctx.body = res;
    });

    router.get("/schedules", async (ctx: Context) => {
      const res = await this.sendPromised({ kind: "searchSchedules", id: ctx.query.id as string });
      if (res.kind !== "searchSchedules") {
        util.panic("unreachable");
        return;
      }
      ctx.status = 200;
      ctx.type = "application/json";
      ctx.body = { schedules: res.schedules };
    });

    router.post("/schedules", async (ctx: Context) => {
      const { id, description, cron, tags, promiseId, promiseTimeout, promiseParam, promiseTags } = ctx.request
        .body as {
        id: string;
        description: string;
        cron: string;
        tags: Record<string, string>;
        promiseId: string;
        promiseTimeout: number;
        promiseParam: any; // Assuming 'Value' schema translates to 'any' here
        promiseTags: Record<string, string>;
        idempotencyKey: string;
      };

      const res = await this.sendPromised({
        kind: "createSchedule",
        id,
        cron,
        promiseId,
        promiseTimeout,
        iKey: ctx.request.headers["idempotency-key"] as string,
        description,
        tags,
        promiseParam,
        promiseTags,
      });
      if (res.kind !== "createSchedule") {
        util.panic("unreachable");
        return;
      }

      ctx.status = 200;
      ctx.type = "application/json";
      ctx.body = res;
    });

    router.get("/schedules/:id", async (ctx: Context) => {
      const res = await this.sendPromised({ kind: "readSchedule", id: ctx.params.id as string });
      if (res.kind !== "readSchedule") {
        util.panic("unreachable");
        return;
      }
      ctx.status = 200;
      ctx.type = "application/json";
      ctx.body = res;
    });

    router.delete("/schedules/:id", async (ctx: Context) => {
      const res = await this.sendPromised({ kind: "deleteSchedule", id: ctx.params.id as string });
      if (res.kind !== "deleteSchedule") {
        util.panic("unreachable");
        return;
      }
      ctx.status = 204;
      ctx.type = "application/json";
    });

    router.post("/tasks/claim", async (ctx: Context) => {
      const { id, counter, processId, ttl } = ctx.request.body as {
        id: string;
        counter: number;
        processId: string;
        ttl: number;
      };
      const res = await this.sendPromised({ kind: "claimTask", id, counter, processId, ttl });
      if (res.kind !== "claimTask") {
        util.panic("unreachable");
        return;
      }
      ctx.body = { type: res.message.kind, promises: res.message.promises };
      ctx.status = 201;
      ctx.type = "application/json";
    });
    router.post("/tasks/complete", async (ctx: Context) => {
      const { id, counter } = ctx.request.body as {
        id: string;
        counter: number;
      };
      const res = await this.sendPromised({ kind: "completeTask", id, counter });
      if (res.kind !== "completeTask") {
        util.panic("unreachable");
        return;
      }
      ctx.body = res.task;
      ctx.status = 201;
      ctx.type = "application/json";
    });
    router.post("/tasks/heartbeat", async (ctx: Context) => {
      const { processId } = ctx.request.body as {
        processId: string;
      };
      const res = await this.sendPromised({ kind: "heartbeatTasks", processId });
      if (res.kind !== "heartbeatTasks") {
        util.panic("unreachable");
        return;
      }
      ctx.body = res.tasksAffected;
      ctx.status = 200;
      ctx.type = "application/json";
    });

    return router;
  }

  getMessageSource(): MessageSource {
    return this.messageSource;
  }

  start() {
    const port = 8001;
    this.webapp = koa.listen(port, () => {
      console.log(`time=${new Date().toISOString()} level=INFO msg="starting http server" addr=:${port}`);
    });
  }

  stop() {
    if (this.webapp !== undefined) this.webapp.close();
  }

  send<T extends Request>(req: Request, callback: (err?: ResonateError, res?: ResponseFor<T>) => void): void {
    setTimeout(() => {
      try {
        const res = this.server.process(req, Date.now());
        util.assert(res.kind === req.kind, "res kind must match req kind");

        callback(undefined, res as ResponseFor<T>);
        this.messageSource.enqueueNext();
      } catch (err) {
        callback(err as ResonateError);
      }
    });
  }
}
