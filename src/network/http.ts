import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventSource } from "eventsource";
import * as util from "../util.js";
import type { Network } from "./network.js";

export interface HttpNetworkConfig {
  url?: string;
  timeout?: number;
  headers?: { [key: string]: string };
  pid?: string;
  group?: string;
  messageSource?: "poll" | "push";
  auth?: { username: string; password: string };
  token?: string;
}

export class HttpNetwork implements Network {
  private url: string;
  private timeout: number;
  private headers: { [key: string]: string };
  private _messageSource?: PollMessageSource | PushMessageSource;
  private _pid: string;
  private _group: string;

  constructor({
    url = "http://localhost:8001",
    timeout = 10000 * util.SEC,
    headers = {},
    auth = undefined,
    token = undefined,
    pid = undefined,
    group = "default",
    messageSource = undefined,
  }: HttpNetworkConfig) {
    this.url = url;
    this.timeout = timeout;

    this.headers = { "Content-Type": "application/json", ...headers };
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    } else if (auth) {
      this.headers.Authorization = `Basic ${util.base64Encode(`${auth.username}:${auth.password}`)}`;
    }

    this._pid = pid ?? crypto.randomUUID().replace(/-/g, "");
    this._group = group;

    if (messageSource === "poll") {
      this._messageSource = new PollMessageSource({ url, pid, group, auth, token });
    } else if (messageSource === "push") {
      this._messageSource = new PushMessageSource({ pid, group });
    }
  }

  get pid(): string {
    util.assert(this._messageSource !== undefined);
    return this._pid;
  }

  get group(): string {
    return this._group;
  }

  get unicast(): string {
    util.assert(this._messageSource !== undefined);
    return this._messageSource.unicast;
  }

  get anycast(): string {
    util.assert(this._messageSource !== undefined);
    return this._messageSource.anycast;
  }

  async start(): Promise<void> {
    util.assert(this._messageSource !== undefined);
    await this._messageSource.start();
  }

  async stop(): Promise<void> {
    util.assert(this._messageSource !== undefined);
    await this._messageSource.stop();
  }

  recv(callback: (msg: string) => void): void {
    this._messageSource?.subscribe(callback);
  }

  match(target: string): string {
    util.assert(this._messageSource !== undefined);
    return this._messageSource.match(target);
  }

  async send(req: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.url}/api`, {
        method: "POST",
        headers: this.headers,
        body: req,
        signal: controller.signal,
      });

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }
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
      this.recv(event.data);
    });

    this.eventSource.addEventListener("error", () => {
      this.eventSource.close();

      console.warn(`Networking. Cannot connect to [${this.url}/poll]. Retrying in 5s.`);
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
