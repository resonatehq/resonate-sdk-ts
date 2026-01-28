import { EventSource } from "eventsource";
import exceptions, { ResonateError, type ResonateServerError } from "../exceptions";
import * as util from "../util";
import type {
  Message,
  MessageSource,
  Network,
  PromiseCreateReq,
  PromiseCreateRes,
  PromiseGetReq,
  PromiseGetRes,
  PromiseRegisterReq,
  PromiseRegisterRes,
  PromiseSettleReq,
  PromiseSettleRes,
  PromiseSubscribeReq,
  PromiseSubscribeRes,
  Req,
  Res,
  ScheduleCreateReq,
  ScheduleCreateRes,
  ScheduleDeleteReq,
  ScheduleDeleteRes,
  ScheduleGetReq,
  ScheduleGetRes,
  TaskAcquireReq,
  TaskAcquireRes,
  TaskCreateReq,
  TaskCreateRes,
  TaskFulfillReq,
  TaskFulfillRes,
  TaskHeartbeatReq,
  TaskHeartbeatRes,
  TaskReleaseReq,
  TaskReleaseRes,
} from "./network";

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
  private headers: { [key: string]: string };
  private verbose: boolean;

  constructor({
    url = "http://localhost:8001",
    timeout = 30 * util.SEC,
    headers = {},
    auth = undefined,
    token = undefined,
    verbose = false,
  }: {
    url?: string;
    timeout?: number;
    headers?: { [key: string]: string };
    auth?: { username: string; password: string };
    token?: string;
    verbose: boolean;
  }) {
    this.url = url;
    this.timeout = timeout;
    this.verbose = verbose;

    this.headers = { "Content-Type": "application/json", ...headers };
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    } else if (auth) {
      this.headers.Authorization = `Basic ${util.base64Encode(`${auth.username}:${auth.password}`)}`;
    }
  }

  send(
    req: Req<string>,
    callback: (res: Res) => void,
    headers: { [key: string]: string } = {},
    retryForever = false,
  ): void {
    const retryPolicy = retryForever ? { retries: Number.MAX_SAFE_INTEGER, delay: 1000 } : { retries: 0 };

    this.handleRequest(req, headers, retryPolicy).then(
      (res) => {
        util.assert(res.kind === req.kind, "res kind must match req kind");
        callback(res);
      },
      (err) => {
        util.assert(false, "something went wrong");
      },
    );
  }

  public start(): void {}
  public stop(): void {}

  private async handleRequest(
    req: Req<string>,
    headers: { [key: string]: string },
    retryPolicy: RetryPolicy = {},
  ): Promise<Res> {
    switch (req.kind) {
      case "promise.create":
        return this.promiseCreate(req, headers, retryPolicy);
      case "task.create":
        return this.taskCreate(req, headers, retryPolicy);
      case "promise.get":
        return this.promiseGet(req, retryPolicy);
      case "promise.settle":
        return this.promiseSettle(req, retryPolicy);
      case "promise.register":
        return this.promiseRegister(req, headers, retryPolicy);
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
      case "task.fulfill":
        return this.taskFulfill(req, retryPolicy);
      case "task.release":
        return this.taskRelease(req, retryPolicy);
      case "task.heartbeat":
        return this.taskHeartbeat(req, retryPolicy);
      case "task.fence": {
        util.assert(false, "not implemented");
        break;
      }
      case "task.get": {
        util.assert(false, "not implemented");
        break;
      }
      case "task.suspend": {
        util.assert(false, "not implemented");
      }
    }
  }

  private async promiseCreate(
    req: PromiseCreateReq<string>,
    headers: { [key: string]: string },
    retryPolicy: RetryPolicy = {},
  ): Promise<PromiseCreateRes> {
    const res = await this.fetch(
      "/promises",
      {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as PromiseCreateRes;
  }

  private async taskCreate(
    req: TaskCreateReq<string>,
    headers: { [key: string]: string },
    retryPolicy: RetryPolicy = {},
  ): Promise<TaskCreateRes> {
    const res = await this.fetch(
      "/promises/task",
      {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskCreateRes;
  }

  private async promiseGet(req: PromiseGetReq, retryPolicy: RetryPolicy = {}): Promise<PromiseGetRes> {
    const res = await this.fetch(`/promises/${encodeURIComponent(req.data.id)}`, { method: "GET" }, retryPolicy);

    return (await res.json()) as PromiseGetRes;
  }

  private async promiseSettle(req: PromiseSettleReq<string>, retryPolicy: RetryPolicy = {}): Promise<PromiseSettleRes> {
    const headers: { [key: string]: string } = {};
    const res = await this.fetch(
      `/promises/${encodeURIComponent(req.data.id)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as PromiseSettleRes;
  }

  private async promiseRegister(
    req: PromiseRegisterReq,
    headers: { [key: string]: string },
    retryPolicy: RetryPolicy = {},
  ): Promise<PromiseRegisterRes> {
    const res = await this.fetch(
      `/promises/callback/${encodeURIComponent(req.data.awaited)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as PromiseRegisterRes;
  }

  private async promiseSubscribe(
    req: PromiseSubscribeReq,
    retryPolicy: RetryPolicy = {},
  ): Promise<PromiseSubscribeRes> {
    const res = await this.fetch(
      `/promises/subscribe/${encodeURIComponent(req.data.awaited)}`,
      {
        method: "POST",
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as PromiseSubscribeRes;
  }

  private async scheduleCreate(
    req: ScheduleCreateReq<string>,
    retryPolicy: RetryPolicy = {},
  ): Promise<ScheduleCreateRes> {
    const headers: { [key: string]: string } = {};

    const res = await this.fetch(
      "/schedules",
      {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as ScheduleCreateRes;
  }

  private async scheduleGet(req: ScheduleGetReq, retryPolicy: RetryPolicy = {}): Promise<ScheduleGetRes> {
    const res = await this.fetch(`/schedules/${encodeURIComponent(req.data.id)}`, { method: "GET" }, retryPolicy);

    return (await res.json()) as ScheduleGetRes;
  }

  private async scheduleDelete(req: ScheduleDeleteReq, retryPolicy: RetryPolicy = {}): Promise<ScheduleDeleteRes> {
    const res = await this.fetch(`/schedules/${encodeURIComponent(req.data.id)}`, { method: "DELETE" }, retryPolicy);

    return (await res.json()) as ScheduleDeleteRes;
  }

  private async taskAcquire(req: TaskAcquireReq, retryPolicy: RetryPolicy = {}): Promise<TaskAcquireRes> {
    const res = await this.fetch(
      "/tasks/claim",
      {
        method: "POST",
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskAcquireRes;
  }

  private async taskFulfill(req: TaskFulfillReq<string>, retryPolicy: RetryPolicy = {}): Promise<TaskFulfillRes> {
    const res = await this.fetch(
      "/tasks/complete",
      {
        method: "POST",
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskFulfillRes;
  }

  private async taskRelease(req: TaskReleaseReq, retryPolicy: RetryPolicy = {}): Promise<TaskReleaseRes> {
    const res = await this.fetch(
      "/tasks/drop",
      {
        method: "POST",
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskReleaseRes;
  }

  private async taskHeartbeat(req: TaskHeartbeatReq, retryPolicy: RetryPolicy = {}): Promise<TaskHeartbeatRes> {
    const res = await this.fetch(
      "/tasks/heartbeat",
      {
        method: "POST",
        body: JSON.stringify(req),
      },
      retryPolicy,
    );

    return (await res.json()) as TaskHeartbeatRes;
  }

  private async fetch(
    path: string,
    init: RequestInit,
    { retries = 0, delay = 1000 }: RetryPolicy = {},
  ): Promise<globalThis.Response> {
    const url = `${this.url}${path}`;

    // add default headers
    init.headers = { ...this.headers, ...init.headers };

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const ver = res.headers.get("Resonate-Version") ?? "0.0.0";

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
      let msg: Message;

      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.warn("Networking. Received invalid message. Will continue.");
        return;
      }

      this.recv(msg);
    });

    this.eventSource.addEventListener("error", () => {
      // some browsers/runtimes may handle automatic reconnect
      // differently, so to ensure consistency close the eventsource
      // and recreate
      this.eventSource.close();

      console.warn(`Networking. Cannot connect to [${this.url}/poll]. Retrying in 5s.`);
      setTimeout(() => this.connect(), 5000);
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
  }

  public subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }
  match(target: string): string {
    return `poll://any@${target}`;
  }
}
