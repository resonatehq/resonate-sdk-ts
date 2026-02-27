import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventSource } from "eventsource";
import exceptions, { ResonateError } from "../exceptions.js";
import * as util from "../util.js";
import type { MessageSource, Network } from "./network.js";
import type { Message } from "./types.js";

export interface HttpNetworkConfig {
  url?: string;
  timeout?: number;
  headers?: { [key: string]: string };
  auth?: { username: string; password: string };
  token?: string;
  verbose?: boolean;
}

export type RetryPolicy = {
  retries?: number;
  delay?: number;
};

export class HttpNetwork implements Network<string, string> {
  private url: string;
  private timeout: number;
  private headers: { [key: string]: string };
  private verbose: boolean;

  constructor({
    url = "http://localhost:8001",
    timeout = 10000 * util.SEC,
    headers = {},
    auth = undefined,
    token = undefined,
    verbose = true,
  }: HttpNetworkConfig) {
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

  start(): void {}
  stop(): void {}

  send(
    req: string,
    callback: (res: string) => void,
    headers: { [key: string]: string } = {},
    retryForever = false,
  ): void {
    const retryPolicy = retryForever ? { retries: Number.MAX_SAFE_INTEGER, delay: 10000 } : { retries: 0 };

    this.doSend(req, headers, retryPolicy).then(
      (res) => {
        callback(res);
      },
      (err) => {
        console.error(err);
        util.assert(false, "something went wrong");
      },
    );
  }

  private async doSend(
    req: string,
    headers: { [key: string]: string },
    { retries = 0, delay = 1000 }: RetryPolicy = {},
  ): Promise<string> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        if (this.verbose) {
          console.log("[HttpNetwork] Sending:", JSON.stringify(req, null, 2));
        }

        const response = await fetch(`${this.url}/api`, {
          method: "POST",
          headers: { ...this.headers, ...headers },
          body: JSON.stringify(req),
          signal: controller.signal,
        });

        const body = await response.json();
        if (this.verbose) {
          console.log(
            `[HttpNetwork] Received ${response.status}:`,
            `for request:`,
            req,
            `response.ok:${response.ok}`,
            body,
          );
        }

        if (response.status === 200 || response.status === 300) {
          return body as string;
        } else {
          const err = body as any;
          throw exceptions.SERVER_ERROR(
            err?.message ?? response.statusText,
            response.status >= 500 && response.status < 600,
            err,
          );
        }
      } catch (err) {
        console.log(err);
        if (err instanceof ResonateError && !err.retriable) {
          throw err;
        }
        if (attempt >= retries) {
          if (err instanceof ResonateError) {
            throw err;
          }
          throw exceptions.SERVER_ERROR(String(err));
        }

        console.warn(`Networking. Cannot connect to [${this.url}]. Retrying in ${delay / 1000}s.`);
        if (this.verbose) {
          console.warn(err);
        }

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
    execute: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { execute: [], notify: [] };

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

  public subscribe(type: "execute" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }

  match(target: string): string {
    return `poll://any@${target}`;
  }
}

export class PushMessageSource implements MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private host: string;
  private port: number;
  private server: Server;
  private subscriptions: {
    execute: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { execute: [], notify: [] };

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

  public start(): void {
    this.server.listen(this.port, this.host, () => {
      const addr = this.server.address();
      if (addr && typeof addr === "object") {
        this.port = addr.port;
      }

      // set addresses now that we know the port
      (this as any).unicast = `http://${this.host}:${this.port}`;
      (this as any).anycast = `http://${this.host}:${this.port}`;
    });
  }

  public stop(): void {
    this.server.close();
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
      let msg: Message;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!msg.kind || !this.subscriptions[msg.kind]) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid message kind" }));
        return;
      }

      this.recv(msg);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
  }

  recv(msg: Message): void {
    for (const callback of this.subscriptions[msg.kind]) {
      callback(msg);
    }
  }

  public subscribe(type: "execute" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }

  match(target: string): string {
    return `http://${this.host}:${this.port}`;
  }
}
