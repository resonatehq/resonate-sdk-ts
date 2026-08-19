import { getEnv, isMessage, type Logger, type Message, randomUUID, type Source } from "@resonatehq/base";
import { EventSource } from "eventsource";

// =============================================================================
// SseConnection
// =============================================================================
//
// A `Source` (push only): subscribes to the Resonate server's poll endpoint
// (`{url}/poll/{group}/{pid}`) over Server-Sent Events and delivers each
// execute/unblock message to the registered callbacks. Relies only on `fetch`
// and `EventSource`, so it runs in any environment.
//
// SSE has no request half; pair it with an `HttpConnection` (or any other
// `Network`) for the request/response path.

export interface SseConnectionConfig {
  /** Resonate server base URL. Falls back to `RESONATE_URL`, then localhost. */
  url?: string;
  /** Worker group; a task targets the group (anycast). Default "default". */
  group?: string;
  /** This process's id; a callback/listener targets it (unicast). Defaults to a random id. */
  pid?: string;
  token?: string;
  logger?: Logger;
}

export class SseConnection implements Source {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private pollUrl: string;
  private headers: { [key: string]: string };
  private eventSource?: EventSource;
  private callbacks: Array<(msg: Message) => void> = [];
  private logger?: Logger;
  private stopped = false;

  // Exponential backoff state
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private static readonly INITIAL_BACKOFF_MS = 1000;
  private static readonly MAX_BACKOFF_MS = 30000;

  constructor({
    url = undefined,
    group = "default",
    pid = undefined,
    token = undefined,
    logger = undefined,
  }: SseConnectionConfig = {}) {
    const baseUrl = url ?? getEnv("RESONATE_URL") ?? "http://localhost:8001";
    this.pid = pid ?? randomUUID().replace(/-/g, "");
    this.group = group;
    this.logger = logger;

    this.pollUrl = `${baseUrl}/poll/${encodeURIComponent(this.group)}/${encodeURIComponent(this.pid)}`;
    this.unicast = `poll://uni@${this.group}/${this.pid}`;
    this.anycast = `poll://any@${this.group}/${this.pid}`;

    this.headers = {};
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    }
  }

  match(target: string): string {
    return `poll://any@${target}`;
  }

  start(): Promise<void> {
    if (!this.stopped && !this.eventSource) {
      this.connect();
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.eventSource?.close();
    return Promise.resolve();
  }

  recv(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }

  private connect(): void {
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

    this.eventSource.addEventListener("open", () => {
      if (this.reconnectAttempt > 0) {
        this.logger?.info(
          { component: "network", connection: "sse", address: this.pollUrl, attempt: this.reconnectAttempt },
          "source reconnected",
        );
      } else {
        this.logger?.info({ component: "network", connection: "sse", address: this.pollUrl }, "source connected");
      }
      this.reconnectAttempt = 0;
    });

    this.eventSource.addEventListener("message", (event) => {
      this.deliver(event.data);
    });

    this.eventSource.addEventListener("error", () => {
      this.eventSource?.close();
      if (this.stopped) return;

      this.reconnectAttempt++;
      const delay = Math.min(
        SseConnection.INITIAL_BACKOFF_MS * 2 ** (this.reconnectAttempt - 1),
        SseConnection.MAX_BACKOFF_MS,
      );

      this.logger?.warn(
        {
          component: "network",
          connection: "sse",
          error: "SSE connection error",
          attempt: this.reconnectAttempt,
        },
        "source reconnecting",
      );

      this.reconnectTimer = setTimeout(() => this.connect(), delay);
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
}
