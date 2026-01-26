import {
  assert,
  type ErrorRes,
  type Message,
  type PromiseCreateReq,
  type PromiseCreateRes,
  type PromiseGetReq,
  type PromiseGetRes,
  type PromiseRegisterReq,
  type PromiseRegisterRes,
  type PromiseSettleReq,
  type PromiseSettleRes,
  type PromiseSubscribeReq,
  type PromiseSubscribeRes,
  type Req,
  type Res,
  type ScheduleCreateReq,
  type ScheduleCreateRes,
  type ScheduleDeleteReq,
  type ScheduleDeleteRes,
  type ScheduleGetReq,
  type TaskAcquireReq,
  type TaskAcquireRes,
  type TaskCreateReq,
  type TaskCreateRes,
  type TaskHeartbeatReq,
  type TaskHeartbeatRes,
  type TaskReleaseReq,
  type TaskReleaseRes,
  type TaskSuspendReq,
  type TaskSuspendRes,
} from "@resonatehq/dev";
import { EventSource } from "eventsource";
import exceptions, { ResonateError, type ResonateServerError } from "../exceptions";
import * as util from "../util";
import type { MessageSource, Network } from "./network";

export interface HttpNetworkConfig {
  verbose: boolean;
  url: string;
  auth?: { username: string; password: string };
  token?: string;
  timeout?: number;
  headers?: { [key: string]: string };
}

export type RetryPolicy = {
  retries?: number;
  delay?: number;
};

export class HttpNetwork implements Network {
  private EXCPECTED_RESONATE_VERSION = "0.7.15";

  private url: string;
  private timeout: number;
  private verbose: boolean;

  constructor({
    url = "http://localhost:8001",
    timeout = 30 * util.SEC,
    verbose = false,
  }: {
    url?: string;
    timeout?: number;
    verbose: boolean;
  }) {
    this.url = url;
    this.timeout = timeout;
    this.verbose = verbose;
  }

  send(req: Req, callback: (res: Res) => void, retryForever = false): void {
    const retryPolicy = retryForever ? { retries: Number.MAX_SAFE_INTEGER, delay: 1000 } : { retries: 0 };

    this.handleRequest(req, retryPolicy).then(
      (res) => {
        assert(res.kind === req.kind || res.kind === "error", "res kind must match req kind or be error");
        callback(res);
      },
      (err) => {
        callback(err);
      },
    );
  }

  public start(): void {}
  public stop(): void {}

  private async handleRequest(req: Req, retryPolicy: RetryPolicy = {}): Promise<Res> {
    switch (req.kind) {
      case "promise.create":
        return this.promiseCreate(req, retryPolicy);
      case "task.create":
        return this.taskCreate(req, retryPolicy);
      case "promise.get":
        return this.promiseGet(req, retryPolicy);
      case "promise.settle":
        return this.promiseSettle(req, retryPolicy);
      case "promise.register":
        return this.promiseRegister(req, retryPolicy);
      case "promise.subscribe":
        return this.promiseSubscribe(req, retryPolicy);
      case "schedule.create":
        return this.scheduleCreate(req, retryPolicy);
      case "schedule.get":
        return this.scheduleGet(req, retryPolicy);
      case "schedule.delete":
        return this.scheduleDelete(req, retryPolicy);
      case "task.acquire":
        return this.taskAcquire(req, retryPolicy);
      case "task.suspend":
        return this.taskSuspend(req, retryPolicy);
      case "task.release":
        return this.taskRelease(req, retryPolicy);
      case "task.heartbeat":
        return this.taskHeartbeat(req, retryPolicy);
      case "task.get": {
        assert(false, "not implemented");
        break;
      }
      case "task.fence": {
        assert(false, "not implemented");
        break;
      }
      case "task.fulfill": {
        assert(false, "not implemented");
        break;
      }
    }
  }

  private async promiseCreate(
    req: PromiseCreateReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<PromiseCreateRes | ErrorRes> {
    const res = await this.fetch(
      "/promises",
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );
    return (await res.json()) as PromiseCreateRes | ErrorRes;
  }

  private async taskCreate(req: TaskCreateReq, retryPolicy: RetryPolicy = {}): Promise<TaskCreateRes | ErrorRes> {
    const res = await this.fetch(
      "/promises/task",
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );
    return (await res.json()) as TaskCreateRes | ErrorRes;
  }

  private async promiseGet(req: PromiseGetReq, retryPolicy: RetryPolicy = {}): Promise<PromiseGetRes | ErrorRes> {
    const res = await this.fetch(`/promises/${encodeURIComponent(req.data.id)}`, { method: "GET" }, retryPolicy);
    return (await res.json()) as PromiseGetRes | ErrorRes;
  }

  private async promiseSettle(
    req: PromiseSettleReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<PromiseSettleRes | ErrorRes> {
    const res = await this.fetch(
      `/promises/${encodeURIComponent(req.data.id)}`,
      {
        method: "PATCH",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as PromiseSettleRes | ErrorRes;
  }

  private async promiseRegister(
    req: PromiseRegisterReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<PromiseRegisterRes | ErrorRes> {
    const res = await this.fetch(
      `/promises/callback/${encodeURIComponent(req.data.awaited)}`,
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as PromiseRegisterRes | ErrorRes;
  }

  private async promiseSubscribe(
    req: PromiseSubscribeReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<PromiseSubscribeRes | ErrorRes> {
    const res = await this.fetch(
      `/promises/subscribe/${encodeURIComponent(req.data.awaited)}`,
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as PromiseSubscribeRes | ErrorRes;
  }

  private async scheduleCreate(
    req: ScheduleCreateReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<ScheduleCreateRes | ErrorRes> {
    const res = await this.fetch(
      "/schedules",
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as ScheduleCreateRes | ErrorRes;
  }

  private async scheduleGet(req: ScheduleGetReq, retryPolicy: RetryPolicy = {}): Promise<ScheduleCreateRes | ErrorRes> {
    const res = await this.fetch(
      `/schedules/${encodeURIComponent(req.data.id)}`,
      { method: "GET", headers: req.head },
      retryPolicy,
    );

    return (await res.json()) as ScheduleCreateRes | ErrorRes;
  }

  private async scheduleDelete(
    req: ScheduleDeleteReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<ScheduleDeleteRes | ErrorRes> {
    const res = await this.fetch(
      `/schedules/${encodeURIComponent(req.data.id)}`,
      { method: "DELETE", headers: req.head },
      retryPolicy,
    );

    return (await res.json()) as ScheduleDeleteRes | ErrorRes;
  }

  private async taskAcquire(req: TaskAcquireReq, retryPolicy: RetryPolicy = {}): Promise<TaskAcquireRes | ErrorRes> {
    const res = await this.fetch(
      "/tasks/claim",
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskAcquireRes | ErrorRes;
  }

  private async taskSuspend(req: TaskSuspendReq, retryPolicy: RetryPolicy = {}): Promise<TaskSuspendRes | ErrorRes> {
    const res = await this.fetch(
      "/tasks/complete",
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskSuspendRes | ErrorRes;
  }

  private async taskRelease(req: TaskReleaseReq, retryPolicy: RetryPolicy = {}): Promise<TaskReleaseRes | ErrorRes> {
    const res = await this.fetch(
      "/tasks/drop",
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskReleaseRes | ErrorRes;
  }

  private async taskHeartbeat(
    req: TaskHeartbeatReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<TaskHeartbeatRes | ErrorRes> {
    const res = await this.fetch(
      "/tasks/heartbeat",
      {
        method: "POST",
        headers: req.head,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );
    return (await res.json()) as TaskHeartbeatRes | ErrorRes;
  }

  private async fetch(
    path: string,
    init: RequestInit,
    { retries = 0, delay = 1000 }: RetryPolicy = {},
  ): Promise<Response> {
    const url = `${this.url}${path}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const ver = res.headers.get("version") ?? "0.0.0";

        if (util.semverLessThan(ver, this.EXCPECTED_RESONATE_VERSION)) {
          console.warn(
            `Networking. Resonate server ${this.EXCPECTED_RESONATE_VERSION} or newer required (provided ${ver}). Will continue.`,
          );
        }

        if (!res.ok) {
          const err = (await res
            .json()
            .then((r: any) => r.error)
            .catch(() => undefined)) as ResonateServerError | undefined;
          throw exceptions.SERVER_ERROR(err ? err.message : res.statusText, res.status >= 500 && res.status < 600, err);
        }

        return res;
      } catch (err) {
        if (err instanceof ResonateError && !err.retriable) {
          throw err;
        }
        if (attempt >= retries) {
          throw exceptions.SERVER_ERROR(String(err));
        }

        console.warn(`Networking. Cannot connect to [${this.url}]. Retrying in ${delay / 1000}s.`);
        if (this.verbose) {
          console.warn(err);
        }

        // sleep before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new Error("Fetch error");
  }
}

export class PollMessageSource implements MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private url: string;
  private headers: { [key: string]: string };
  private eventSource: EventSource;
  private subscriptions: {
    invoke: Array<(msg: Message) => void>;
    resume: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { invoke: [], resume: [], notify: [] };
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor({
    url = "http://localhost:8001",
    pid = crypto.randomUUID().replace(/-/g, ""),
    group = "default",
    auth = undefined,
    token = undefined,
  }: {
    url?: string;
    pid?: string;
    group?: string;
    auth?: { username: string; password: string };
    token?: string;
  }) {
    this.url = url;
    this.pid = pid;
    this.group = group;
    this.unicast = `poll://uni@${group}/${pid}`;
    this.anycast = `poll://any@${group}/${pid}`;

    this.headers = {};
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    } else if (auth) {
      this.headers.Authorization = `Basic ${util.base64Encode(`${auth.username}:${auth.password}`)}`;
    }

    this.eventSource = this.connect();
  }

  private connect() {
    const url = new URL(`/poll/${encodeURIComponent(this.group)}/${encodeURIComponent(this.pid)}`, `${this.url}`);
    this.eventSource = new EventSource(url, {
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...init.headers,
            ...this.headers,
          },
        }),
    });

    this.eventSource.addEventListener("message", (event) => {
      let mesg: Message;

      try {
        const parsed = JSON.parse(event.data);
        mesg = parsed;
      } catch (e) {
        console.warn("Networking. Received invalid message. Will continue.");
        return;
      }

      this.recv(mesg);
    });

    this.eventSource.addEventListener("error", () => {
      // some browsers/runtimes may handle automatic reconnect
      // differently, so to ensure consistency close the eventsource
      // and recreate
      this.eventSource.close();

      // Prevent multiple reconnect attempts
      if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

      console.warn(`Networking. Cannot connect to [${this.url}/poll]. Retrying in 5s.`);
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null;
        this.connect();
      }, 5000);
    });

    return this.eventSource;
  }

  recv(msg: Message): void {
    for (const callback of this.subscriptions[msg.kind]) {
      callback(msg);
    }
  }

  public start(): void {}

  public stop(): void {
    this.eventSource.close();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
  }

  public subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }
  match(target: string): string {
    return `poll://any@${target}`;
  }
}
