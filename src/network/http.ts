import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventSource } from "eventsource";
import exceptions from "../exceptions.js";
import type { Logger } from "../logger.js";
import * as util from "../util.js";
import type { Network } from "./network.js";
import { isMessage, isResponse, type Message, type Request, type Response } from "./types.js";

export interface HttpNetworkConfig {
  url?: string;
  timeout?: number;
  headers?: { [key: string]: string };
  pid?: string;
  group?: string;
  messageSource?: "poll" | "push";
  auth?: { username: string; password: string };
  token?: string;
  logger?: Logger;
}

export class HttpNetwork implements Network {
  private url: string;
  private timeout: number;
  private headers: { [key: string]: string };
  private _messageSource?: PollMessageSource | PushMessageSource;
  private logger?: Logger;

  constructor({
    url = "http://localhost:8001",
    timeout = 10000 * util.SEC,
    headers = {},
    auth = undefined,
    token = undefined,
    pid = undefined,
    group = "default",
    messageSource = undefined,
    logger = undefined,
  }: HttpNetworkConfig) {
    this.url = url;
    this.timeout = timeout;
    this.logger = logger;

    this.headers = { "Content-Type": "application/json", ...headers };
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    } else if (auth) {
      this.headers.Authorization = `Basic ${util.base64Encode(`${auth.username}:${auth.password}`)}`;
    }

    if (messageSource === "poll") {
      this._messageSource = new PollMessageSource({ url, pid, group, auth, token, logger });
    } else if (messageSource === "push") {
      this._messageSource = new PushMessageSource({ pid, group });
    }
  }

  get unicast(): string {
    util.assert(this._messageSource !== undefined);
    return this._messageSource.unicast;
  }

  get anycast(): string {
    util.assert(this._messageSource !== undefined);
    return this._messageSource.anycast;
  }

  async init(): Promise<void> {
    util.assert(this._messageSource !== undefined);
    await this._messageSource.start();
  }

  async stop(): Promise<void> {
    util.assert(this._messageSource !== undefined);
    await this._messageSource.stop();
  }

  recv(callback: (msg: Message) => void): void {
    this._messageSource?.subscribe((msgStr: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msgStr);
      } catch {
        this.logger?.warn({ component: "network" }, "received invalid JSON message, discarding");
        return;
      }
      if (!isMessage(parsed)) {
        this.logger?.warn({ component: "network" }, "received invalid message, discarding");
        return;
      }
      callback(parsed);
    });
  }

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    this.logger?.debug({ component: "network", kind: req.kind, corrId: req.head.corrId }, "sending request");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let resStr: string;
    try {
      const response = await fetch(`${this.url}/api`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      resStr = await response.text();
    } catch (e) {
      throw exceptions.SERVER_ERROR(e instanceof Error ? e.message : String(e), true, {
        code: 500,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    let res: unknown;
    try {
      res = JSON.parse(resStr);
    } catch {
      throw exceptions.SERVER_ERROR("invalid response", true, {
        code: 500,
        message: "Failed to parse response JSON",
      });
    }

    if (!isResponse(res) || res.kind !== req.kind || res.head.corrId !== req.head.corrId) {
      throw exceptions.SERVER_ERROR("invalid response", true, {
        code: 500,
        message: "Response did not match request",
      });
    }

    this.logger?.debug(
      { component: "network", kind: res.kind, corrId: res.head.corrId, status: res.head.status },
      "received response",
    );

    return res as Extract<Response, { kind: K }>;
  };
}

class PollMessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private url: string;
  private headers: { [key: string]: string };
  private eventSource: EventSource;
  private subscribers: Array<(msg: string) => void> = [];
  private logger?: Logger;

  constructor({
    url = "http://localhost:8001",
    pid = crypto.randomUUID().replace(/-/g, ""),
    group = "default",
    auth = undefined,
    token = undefined,
    logger = undefined,
  }: {
    url?: string;
    pid?: string;
    group?: string;
    auth?: { username: string; password: string };
    token?: string;
    logger?: Logger;
  }) {
    this.url = url;
    this.pid = pid;
    this.group = group;
    this.unicast = `poll://uni@${group}/${pid}`;
    this.anycast = `poll://any@${group}/${pid}`;
    this.logger = logger;

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
      this.recv(event.data);
    });

    this.eventSource.addEventListener("error", () => {
      this.eventSource.close();

      if (this.logger) {
        this.logger.warn(
          { component: "network", url: `${this.url}/poll` },
          `Cannot connect to [${this.url}/poll]. Retrying in 5s.`,
        );
      }
      setTimeout(() => this.connect(), 5000);
    });

    return this.eventSource;
  }

  recv(msg: string): void {
    for (const callback of this.subscribers) {
      callback(msg);
    }
  }

  public async start(): Promise<void> {}

  public async stop(): Promise<void> {
    this.eventSource.close();
  }

  public subscribe(callback: (msg: string) => void): void {
    this.subscribers.push(callback);
  }

  match(target: string): string {
    return `poll://any@${target}`;
  }
}

class PushMessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private host: string;
  private port: number;
  private server: Server;
  private subscribers: Array<(msg: string) => void> = [];

  constructor({
    host = "0.0.0.0",
    port = 0,
    pid = crypto.randomUUID().replace(/-/g, ""),
    group = "default",
  }: {
    host?: string;
    port?: number;
    pid?: string;
    group?: string;
  } = {}) {
    this.host = host;
    this.port = port;
    this.pid = pid;
    this.group = group;

    // addresses are set after start() resolves the actual port
    this.unicast = "";
    this.anycast = "";

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }

        // set addresses now that the server is listening and port is known
        (this as any).unicast = `http://${this.host}:${this.port}`;
        (this as any).anycast = `http://${this.host}:${this.port}`;
        resolve();
      });
      this.server.once("error", reject);
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
    });

    req.on("end", () => {
      this.recv(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
  }

  recv(msg: string): void {
    for (const callback of this.subscribers) {
      callback(msg);
    }
  }

  public subscribe(callback: (msg: string) => void): void {
    this.subscribers.push(callback);
  }

  match(target: string): string {
    return `http://${this.host}:${this.port}`;
  }
}
