import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../logger.js";
import * as util from "../util.js";
import type { HttpAdapter } from "./browser.js";
import { isMessage, type Message } from "./types.js";

// =============================================================================
// Server networking
// =============================================================================
//
// This is the server-only entry point. It re-exports the browser-safe core
// (HttpNetwork, PollMessageSource) from ./browser.js and adds PushMessageSource,
// which runs an HTTP server via `node:http`. Because `node:http` cannot run in
// the browser, the SDK's default import graph pulls the shared core from
// ./browser.js directly; only code that explicitly imports this module (or
// PushMessageSource) depends on `node:http`.

export * from "./browser.js";

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
    host = "127.0.0.1",
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

  match(_target: string): string {
    util.assert(this.anycast !== "", "PushMessageSource.match called before init()");
    return this.anycast;
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

        this.logger?.info(
          { component: "network", adapter_type: "HttpPush", address: `${this.host}:${this.port}` },
          "adapter connected",
        );
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
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger?.warn({ component: "network", error, raw_data: msgStr.slice(0, 200) }, "message parse error");
      return;
    }
    if (!isMessage(parsed)) {
      this.logger?.warn(
        { component: "network", error: "invalid message structure", raw_data: msgStr.slice(0, 200) },
        "message parse error",
      );
      return;
    }

    const msgKind = parsed.kind;
    const idField =
      msgKind === "execute" ? { task_id: parsed.data?.task?.id } : { promise_id: parsed.data?.promise?.id };
    this.logger?.debug({ component: "network", msg_kind: msgKind, ...idField }, "message received");

    for (const callback of this.callbacks) {
      callback(parsed);
    }
  }

  public onReceive(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }
}
