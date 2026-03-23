import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventSource } from "eventsource";
import type { Logger } from "../logger.js";
import * as util from "../util.js";
import type { Network } from "./network.js";
import { isMessage, isResponse, type Message, type Request, type Response } from "./types.js";

// =============================================================================
// HttpAdapter Interface
// =============================================================================

export interface HttpAdapter {
  readonly unicast: string;
  readonly anycast: string;
  init(): Promise<void>;
  stop(): Promise<void>;
  onReceive(callback: (msg: Message) => void): void;
}

// =============================================================================
// HttpNetwork
// =============================================================================

export interface HttpNetworkConfig {
  url?: string;
  timeout?: number;
  headers?: { [key: string]: string };
  auth?: { username: string; password: string };
  token?: string;
  logger?: Logger;
  adapter?: HttpAdapter;
}

export class HttpNetwork implements Network {
  private url: string;
  private timeout: number;
  private headers: { [key: string]: string };
  private adapter?: HttpAdapter;
  private logger?: Logger;

  constructor({
    url = "http://localhost:8001",
    timeout = undefined,
    headers = {},
    auth = undefined,
    token = undefined,
    logger = undefined,
    adapter = undefined,
  }: HttpNetworkConfig) {
    this.url = url;

    // Priority: programmatic config > RESONATE_TIMEOUT env var > default (10s)
    const envTimeout = process.env.RESONATE_TIMEOUT ? Number.parseInt(process.env.RESONATE_TIMEOUT, 10) : undefined;
    this.timeout = timeout ?? (envTimeout && !Number.isNaN(envTimeout) ? envTimeout : 10 * util.SEC);
    this.logger = logger;
    this.adapter = adapter;

    this.headers = { "Content-Type": "application/json", ...headers };
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    } else if (auth) {
      this.headers.Authorization = `Basic ${util.base64Encode(`${auth.username}:${auth.password}`)}`;
    }
  }

  get unicast(): string {
    util.assert(this.adapter !== undefined);
    return this.adapter.unicast;
  }

  get anycast(): string {
    util.assert(this.adapter !== undefined);
    return this.adapter.anycast;
  }

  async init(): Promise<void> {
    util.assert(this.adapter !== undefined);
    await this.adapter.init();
  }

  async stop(): Promise<void> {
    util.assert(this.adapter !== undefined);
    await this.adapter.stop();
  }

  recv(callback: (msg: Message) => void): void {
    this.adapter?.onReceive(callback);
  }

  // Valid protocol status codes — responses with these statuses are returned as-is.
  // Everything else is a platform failure that gets collapsed into a synthetic timeout.
  private static readonly PROTOCOL_STATUSES = new Set([200, 300, 404, 409, 422, 501]);

  private syntheticTimeout<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    cause: string,
  ): Extract<Response, { kind: K }> {
    return {
      kind: req.kind,
      head: {
        corrId: req.head.corrId,
        status: 500,
        version: req.head.version,
      },
      data: `platform failure: ${cause}`,
    } as Extract<Response, { kind: K }>;
  }

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    this.logger?.debug({ component: "network", kind: req.kind, corrId: req.head.corrId }, "sending request");

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      let httpResponse: globalThis.Response;
      try {
        httpResponse = await fetch(`${this.url}/api`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(req),
          signal: controller.signal,
        });
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        this.logger?.warn(
          { component: "network", kind: req.kind, corrId: req.head.corrId, error: cause },
          `platform failure: fetch error`,
        );
        return this.syntheticTimeout(req, cause);
      } finally {
        clearTimeout(timeoutId);
      }

      // Check HTTP status — non-protocol statuses are platform failures
      if (!HttpNetwork.PROTOCOL_STATUSES.has(httpResponse.status)) {
        const cause = `HTTP ${httpResponse.status}`;
        this.logger?.warn(
          { component: "network", kind: req.kind, corrId: req.head.corrId, error: cause },
          `platform failure: non-protocol HTTP status`,
        );
        return this.syntheticTimeout(req, cause);
      }

      let resStr: string;
      try {
        resStr = await httpResponse.text();
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        this.logger?.warn(
          { component: "network", kind: req.kind, corrId: req.head.corrId, error: cause },
          `platform failure: failed to read response body`,
        );
        return this.syntheticTimeout(req, cause);
      }

      let res: unknown;
      try {
        res = JSON.parse(resStr);
      } catch {
        this.logger?.warn(
          { component: "network", kind: req.kind, corrId: req.head.corrId },
          `platform failure: failed to parse response JSON`,
        );
        return this.syntheticTimeout(req, "failed to parse response JSON");
      }

      if (!isResponse(res) || res.kind !== req.kind || res.head.corrId !== req.head.corrId) {
        this.logger?.warn(
          { component: "network", kind: req.kind, corrId: req.head.corrId },
          `platform failure: response did not match request`,
        );
        return this.syntheticTimeout(req, "response did not match request");
      }

      this.logger?.debug(
        { component: "network", kind: res.kind, corrId: res.head.corrId, status: res.head.status },
        "received response",
      );

      return res as Extract<Response, { kind: K }>;
    } catch (e) {
      // Catch-all: any unexpected error is also collapsed
      const cause = e instanceof Error ? e.message : String(e);
      this.logger?.warn(
        { component: "network", kind: req.kind, corrId: req.head.corrId, error: cause },
        `platform failure: unexpected error`,
      );
      return this.syntheticTimeout(req, cause);
    }
  };
}

// =============================================================================
// PollMessageSource — implements HttpAdapter
// =============================================================================

export class PollMessageSource implements HttpAdapter {
  readonly unicast: string;
  readonly anycast: string;

  private pollUrl: string;
  private headers: { [key: string]: string };
  private eventSource: EventSource;
  private callbacks: Array<(msg: Message) => void> = [];
  private logger?: Logger;

  constructor({
    url,
    auth = undefined,
    token = undefined,
    logger = undefined,
  }: {
    url: string;
    auth?: { username: string; password: string };
    token?: string;
    logger?: Logger;
  }) {
    this.pollUrl = url;
    this.logger = logger;

    // Derive unicast/anycast from the URL
    // URL format: ${baseUrl}/poll/${group}/${pid}
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    // segments: ["poll", group, pid]
    const group = segments.length >= 2 ? decodeURIComponent(segments[1]) : "default";
    const pid = segments.length >= 3 ? decodeURIComponent(segments[2]) : "";
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
    this.eventSource = new EventSource(this.pollUrl, {
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
      this.deliver(event.data);
    });

    this.eventSource.addEventListener("error", () => {
      this.eventSource.close();

      if (this.logger) {
        this.logger.warn(
          { component: "network", url: this.pollUrl },
          `Cannot connect to [${this.pollUrl}]. Retrying in 5s.`,
        );
      }
      setTimeout(() => this.connect(), 5000);
    });

    return this.eventSource;
  }

  private deliver(msgStr: string): void {
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
    for (const callback of this.callbacks) {
      callback(parsed);
    }
  }

  public async init(): Promise<void> {}

  public async stop(): Promise<void> {
    this.eventSource.close();
  }

  public onReceive(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }
}

// =============================================================================
// PushMessageSource — implements HttpAdapter
// =============================================================================

export class PushMessageSource implements HttpAdapter {
  unicast: string;
  anycast: string;

  private host: string;
  private port: number;
  private server: Server;
  private callbacks: Array<(msg: Message) => void> = [];
  private logger?: Logger;

  constructor({
    host = "0.0.0.0",
    port = 0,
    logger = undefined,
  }: {
    host?: string;
    port?: number;
    logger?: Logger;
  } = {}) {
    this.host = host;
    this.port = port;
    this.logger = logger;

    // addresses are set after init() resolves the actual port
    this.unicast = "";
    this.anycast = "";

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  public init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }

        // set addresses now that the server is listening and port is known
        this.unicast = `http://${this.host}:${this.port}`;
        this.anycast = `http://${this.host}:${this.port}`;
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
      this.deliver(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
  }

  private deliver(msgStr: string): void {
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
    for (const callback of this.callbacks) {
      callback(parsed);
    }
  }

  public onReceive(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }
}
