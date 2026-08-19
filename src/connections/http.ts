import {
  getEnv,
  isResponse,
  type Logger,
  type Network,
  type Request,
  ResonateTimeoutException,
  type Response,
} from "@resonatehq/base";

// =============================================================================
// HttpConnection
// =============================================================================
//
// A `Network` (request/response only): every Resonate protocol request is a
// POST to the server. Relies only on `fetch`, so it runs in any environment —
// Node and the browser alike — without pulling in Node built-ins.
//
// HTTP has no push half; pair it with an `SseConnection` (or any other
// `Source`) when the process must also receive execute/unblock messages. A
// serverless worker that only sends can use this connection alone.

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HttpConnectionConfig {
  url?: string;
  timeout?: number;
  headers?: { [key: string]: string };
  token?: string;
  logger?: Logger;
}

export class HttpConnection implements Network {
  private url: string;
  private timeout: number;
  private headers: { [key: string]: string };
  private token?: string;
  private logger?: Logger;

  constructor({
    url = undefined,
    timeout = undefined,
    headers = {},
    token = undefined,
    logger = undefined,
  }: HttpConnectionConfig = {}) {
    // Priority: programmatic config > RESONATE_URL env var > default
    this.url = url ?? getEnv("RESONATE_URL") ?? "http://localhost:8001";

    // Priority: programmatic config > RESONATE_TIMEOUT env var > default (10s)
    const envTimeoutRaw = getEnv("RESONATE_TIMEOUT");
    const envTimeout = envTimeoutRaw ? Number.parseInt(envTimeoutRaw, 10) : undefined;
    this.timeout = timeout ?? (envTimeout && !Number.isNaN(envTimeout) ? envTimeout : DEFAULT_TIMEOUT_MS);
    this.logger = logger;

    // Priority: programmatic token > env var
    const resolvedToken = token ?? getEnv("RESONATE_TOKEN");

    this.headers = { "Content-Type": "application/json", ...headers };
    if (resolvedToken) {
      this.headers.Authorization = `Bearer ${resolvedToken}`;
      this.token = resolvedToken;
    }
  }

  start(): Promise<void> {
    this.logger?.info({ component: "network", connection: "http", url: this.url }, "network started");
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.logger?.info({ component: "network", connection: "http" }, "network stopped");
    return Promise.resolve();
  }

  // Valid protocol status codes — responses with these statuses are returned as-is.
  // Everything else is a platform failure that throws ResonateTimeoutException.
  private static readonly PROTOCOL_STATUSES = new Set([200, 300, 404, 409, 422, 501]);

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    const startTime = Date.now();
    this.logger?.debug(
      { component: "network", url: `${this.url}`, kind: req.kind, corr_id: req.head.corrId },
      "request sent",
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    if (this.token) {
      req = { ...req, head: { ...req.head, auth: this.token } };
    }

    let httpResponse: globalThis.Response;
    try {
      httpResponse = await fetch(`${this.url}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      const errorType = cause.includes("abort") ? "http_timeout" : "connection_error";
      this.logger?.warn(
        { component: "network", kind: req.kind, corr_id: req.head.corrId, error_type: errorType, error: cause },
        "platform failure",
      );
      throw new ResonateTimeoutException(cause);
    } finally {
      clearTimeout(timeoutId);
    }

    // Check HTTP status — non-protocol statuses are platform failures
    if (!HttpConnection.PROTOCOL_STATUSES.has(httpResponse.status)) {
      const cause = `HTTP ${httpResponse.status}`;
      this.logger?.warn(
        {
          component: "network",
          kind: req.kind,
          corr_id: req.head.corrId,
          error_type: `server_error_${httpResponse.status}`,
          error: cause,
        },
        "platform failure",
      );
      throw new ResonateTimeoutException(cause);
    }

    let resStr: string;
    try {
      resStr = await httpResponse.text();
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      this.logger?.warn(
        {
          component: "network",
          kind: req.kind,
          corr_id: req.head.corrId,
          error_type: "malformed_response",
          error: cause,
        },
        "platform failure",
      );
      throw new ResonateTimeoutException(cause);
    }

    if (httpResponse.status === 404 && !httpResponse.headers.get("content-type")?.includes("application/json")) {
      this.logger?.warn(
        {
          component: "network",
          kind: req.kind,
          corr_id: req.head.corrId,
          error_type: "outdated_server",
        },
        "Legacy server detected. Please upgrade to the latest server: https://github.com/resonatehq/resonate",
      );
      throw new ResonateTimeoutException("legacy server detected");
    }

    let res: unknown;
    try {
      res = JSON.parse(resStr);
    } catch {
      this.logger?.warn(
        {
          component: "network",
          kind: req.kind,
          corr_id: req.head.corrId,
          error_type: "malformed_response",
          error: "failed to parse response JSON",
        },
        "platform failure",
      );
      throw new ResonateTimeoutException("failed to parse response JSON");
    }

    if (!isResponse(res) || res.kind !== req.kind || res.head.corrId !== req.head.corrId) {
      this.logger?.warn(
        {
          component: "network",
          kind: req.kind,
          corr_id: req.head.corrId,
          error_type: "malformed_response",
          error: "response did not match request",
        },
        "platform failure",
      );
      throw new ResonateTimeoutException("response did not match request");
    }

    const durationMs = Date.now() - startTime;
    this.logger?.debug(
      {
        component: "network",
        kind: res.kind,
        corr_id: res.head.corrId,
        status: res.head.status,
        duration_ms: durationMs,
      },
      "protocol response",
    );

    return res as Extract<Response, { kind: K }>;
  };
}
