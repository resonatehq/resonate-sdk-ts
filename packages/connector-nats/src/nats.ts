import { headers, type Msg, type NatsConnection as NatsClient, type Subscription } from "@nats-io/transport-node";
import {
  isMessage,
  isResponse,
  type Logger,
  type Message,
  type Network,
  originOf,
  type Request,
  ResonateTimeoutException,
  type Response,
  randomUUID,
  type Source,
} from "@resonatehq/base";

// =============================================================================
// CONSTANTS
// =============================================================================

// Milliseconds to wait for a server reply before giving up.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Subject prefix the server's request stream is subscribed to. A request for
// `origin` is published to `{apiPrefix}.{base64url(origin)}`; the token is
// base64url-encoded so any origin maps to a single valid subject token and all
// publishers hash the same origin to the same JetStream partition.
// Must match the server's SubjectPrefix (resonate.requests).
const DEFAULT_API_PREFIX = "resonate.requests";

// Subject prefix the SDK subscribes on for execute/unblock messages. The
// `nats://` delivery addresses advertised via unicast/anycast round-trip
// through the server's `url.Parse(host+path)` to these subjects.
const DEFAULT_RECV_PREFIX = "resonate.recv";

// Header the server reads to learn where to publish its reply. The NATS
// request/reply `reply` subject is *not* used by resonate-on-nats.
const REPLY_HEADER = "Resonate-Reply-To";

// =============================================================================
// ROUTING HELPERS
// =============================================================================

// The lineage origin of an id — see `src/ids.ts`. Aliased here because it is
// what selects the server's origin-state partition (below), so it must agree
// with the server's own `origin()` for every id shape.
const idToOrigin = originOf;

// Derive the routing origin from a request, mirroring the server's client.
//
// The origin selects which origin-state partition the server loads, so it must
// be the lineage root of whatever id the request acts on. Requests that do not
// act on a lineage (searches, schedules, debug) route to "default".
function routingOrigin(req: Request): string {
  switch (req.kind) {
    case "promise.get":
    case "promise.create":
    case "promise.settle":
    case "task.get":
    case "task.acquire":
    case "task.release":
    case "task.suspend":
    case "task.halt":
    case "task.continue":
    case "task.fulfill":
    case "task.fence":
      return idToOrigin(req.data.id);
    case "promise.register_callback":
    case "promise.register_listener":
      return idToOrigin(req.data.awaited);
    case "task.create":
      return idToOrigin(req.data.action.data.id);
    case "task.heartbeat":
      return idToOrigin(req.data.tasks[0]?.id ?? "");
    default:
      return "default";
  }
}

// Encode `{prefix}.{base64url(origin)}` — the padding is stripped so the token
// matches the server's `base64.RawURLEncoding`.
function publishSubject(prefix: string, origin: string): string {
  const token = Buffer.from(origin, "utf8").toString("base64url");
  return `${prefix}.${token}`;
}

// =============================================================================
// NatsConnection
// =============================================================================

export interface NatsConnectionConfig {
  // An already-connected NATS client. Its lifecycle lives outside the SDK:
  // `stop()` tears down only this connection's subscriptions and leaves the
  // client for the caller to drain/close.
  conn: NatsClient;
  pid?: string;
  group?: string;
  // Subject prefix the server subscribes on for requests.
  serverTopic?: string;
  // Subject prefix the SDK subscribes on for execute/unblock messages.
  workerTopic?: string;
  // Milliseconds to wait for a reply before failing a `send`.
  requestTimeout?: number;
  logger?: Logger;
}

/**
 * Dual-role connection ({@link Network} + {@link Source}) that talks to
 * resonate-on-nats over NATS.
 *
 * - Requests are published to `{serverTopic}.{base64url(origin)}` with a
 *   `Resonate-Reply-To` header naming a private inbox; the reply arrives on
 *   that inbox (the server ignores the NATS reply subject).
 * - Incoming execute/unblock messages arrive on a unicast subject
 *   (`{workerTopic}.{group}.{pid}`) and an anycast subject
 *   (`{workerTopic}.{group}`) queue-subscribed on `group` so exactly one group
 *   member receives each anycast message.
 * - Addresses use the `nats://` scheme so the server's `url.Parse` maps
 *   `nats://{subject}` back to `{subject}`.
 *
 * `start()` opens the uni/any subscriptions only when a receiver was
 * registered via `recv`, so a network-only NatsConnection never steals
 * messages off its group's queue subscription.
 */
export class NatsConnection implements Network, Source {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private nc: NatsClient;
  private apiPrefix: string;
  private recvPrefix: string;
  private uniSubject: string;
  private anySubject: string;
  private requestTimeout: number;
  private logger?: Logger;

  private callbacks: Array<(msg: Message) => void> = [];
  private subs: Subscription[] = [];
  private stopped = false;

  constructor({
    conn,
    pid = undefined,
    group = undefined,
    serverTopic = DEFAULT_API_PREFIX,
    workerTopic = DEFAULT_RECV_PREFIX,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS,
    logger = undefined,
  }: NatsConnectionConfig) {
    this.nc = conn;
    this.pid = pid ?? randomUUID().replace(/-/g, "");
    this.group = group ?? "default";
    this.apiPrefix = serverTopic;
    this.recvPrefix = workerTopic;
    this.requestTimeout = requestTimeout;
    this.logger = logger;

    // pid/group land in the NATS subject via the server's url.Parse host, which
    // Go lowercases -- uuid hex pids and lowercase groups round-trip cleanly.
    this.uniSubject = `${workerTopic}.${this.group}.${this.pid}`;
    this.anySubject = `${workerTopic}.${this.group}`;
    this.unicast = `nats://${this.uniSubject}`;
    this.anycast = `nats://${this.anySubject}`;
  }

  match(target: string): string {
    return `nats://${this.recvPrefix}.${target}`;
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // Subscribe only when a receiver was registered via `recv`: a network-only
    // NatsConnection must never steal messages off its group's queue
    // subscription.
    if (this.callbacks.length > 0) {
      this.subs = [
        this.nc.subscribe(this.uniSubject, { callback: (err, msg) => this.onMsg(err, msg) }),
        this.nc.subscribe(this.anySubject, { queue: this.group, callback: (err, msg) => this.onMsg(err, msg) }),
      ];
    }
    this.logger?.info(
      { component: "network", connection: "nats", uni: this.uniSubject, any: this.anySubject },
      "connection started",
    );
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    for (const sub of this.subs) {
      try {
        sub.unsubscribe();
      } catch {
        // The connection is owned by the caller; a failed unsubscribe (e.g. the
        // connection already closed) must not block shutdown.
      }
    }
    this.subs = [];
    this.callbacks = [];
    this.logger?.info({ component: "network" }, "network stopped");
    return Promise.resolve();
  }

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    const startTime = Date.now();
    this.logger?.debug({ component: "network", kind: req.kind, corr_id: req.head.corrId }, "request sent");

    if (this.stopped) {
      throw new ResonateTimeoutException("connection has been stopped");
    }

    // The server reads the origin from the head, not the subject; set both.
    const origin = routingOrigin(req);
    const outbound = { ...req, head: { ...req.head, "resonate:origin": origin } };
    const subject = publishSubject(this.apiPrefix, origin);
    const payload = JSON.stringify(outbound);
    const inbox = `_INBOX.${randomUUID().replace(/-/g, "")}`;

    let resStr: string;
    try {
      resStr = await new Promise<string>((resolve, reject) => {
        // `max: 1` auto-unsubscribes after the reply; `timeout` fires the
        // callback with a TimeoutError if no reply arrives in time.
        const sub = this.nc.subscribe(inbox, {
          max: 1,
          timeout: this.requestTimeout,
          callback: (err, msg) => (err ? reject(err) : resolve(msg.string())),
        });
        try {
          const hdrs = headers();
          hdrs.set(REPLY_HEADER, inbox);
          this.nc.publish(subject, payload, { headers: hdrs });
        } catch (e) {
          sub.unsubscribe();
          reject(e);
        }
      });
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      this.logger?.warn(
        { component: "network", kind: req.kind, corr_id: req.head.corrId, error: cause },
        "platform failure",
      );
      throw new ResonateTimeoutException(cause);
    }

    let res: unknown;
    try {
      res = JSON.parse(resStr);
    } catch {
      this.logger?.warn(
        { component: "network", kind: req.kind, corr_id: req.head.corrId, error: "failed to parse response JSON" },
        "platform failure",
      );
      throw new ResonateTimeoutException("failed to parse response JSON");
    }

    if (!isResponse(res) || res.kind !== req.kind || res.head.corrId !== req.head.corrId) {
      this.logger?.warn(
        { component: "network", kind: req.kind, corr_id: req.head.corrId, error: "response did not match request" },
        "platform failure",
      );
      throw new ResonateTimeoutException("response did not match request");
    }

    this.logger?.debug(
      {
        component: "network",
        kind: res.kind,
        corr_id: res.head.corrId,
        status: res.head.status,
        duration_ms: Date.now() - startTime,
      },
      "protocol response",
    );

    return res as Extract<Response, { kind: K }>;
  };

  recv(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }

  // -- internals --------------------------------------------------------------

  private onMsg(err: Error | null, msg: Msg): void {
    if (err) {
      this.logger?.warn({ component: "network", error: err.message }, "subscription error");
      return;
    }

    let str: string;
    try {
      str = msg.string();
    } catch {
      this.logger?.warn({ component: "network", subject: msg.subject }, "dropping non-utf8 NATS message");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(str);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger?.warn({ component: "network", error, raw_data: str.slice(0, 200) }, "message parse error");
      return;
    }

    if (!isMessage(parsed)) {
      this.logger?.warn(
        { component: "network", error: "invalid message structure", raw_data: str.slice(0, 200) },
        "message parse error",
      );
      return;
    }

    const idField =
      parsed.kind === "execute" ? { task_id: parsed.data?.task?.id } : { promise_id: parsed.data?.promise?.id };
    this.logger?.debug({ component: "network", msg_kind: parsed.kind, ...idField }, "message received");

    for (const callback of this.callbacks) {
      callback(parsed);
    }
  }
}
