import { WallClock } from "./clock.js";
import { Codec } from "./codec.js";
import { Core } from "./core.js";
import { type Encryptor, NoopEncryptor } from "./encryptor.js";
import { NoopHeartbeat } from "./heartbeat.js";
import { ConsoleLogger, type Logger, type LogLevel } from "./logger.js";
import { HttpNetwork } from "./network/http.js";
import { isExecuteMsg, type Message } from "./network/types.js";
import { OptionsBuilder } from "./options.js";
import { getEnv, randomUUID } from "./platform.js";
import { Registry } from "./registry.js";
import type { Func } from "./types.js";

/**
 * Outbound credentials for the call back to the Resonate server, resolved per
 * request. Exists because some platforms mint a token per invocation (GCP's
 * metadata server, for one) and cannot bind it at construction time.
 */
export interface HandlerAuth {
  headers?: Record<string, string>;
  token?: string;
}

/**
 * What `handle` needs from an execution engine, and nothing more: the shared
 * constructor, and a way to hand it one message.
 *
 * Deliberately structural rather than `typeof Core`. The two engines have
 * different private members, so nominally they are incompatible; expressed as
 * what is actually used, they are interchangeable — which is the fact worth
 * encoding.
 */
export type CoreConstructor = new (
  options: ConstructorParameters<typeof Core>[0],
) => { onMessage(msg: Message): Promise<{ kind: string } | undefined> };

export interface ResonateHandlerOptions {
  /** Process identifier. Defaults to a fresh UUID per request. */
  pid?: string;
  /**
   * Time-to-live (ms) for acquired tasks. The server releases a task if no
   * heartbeat arrives within this window, and a serverless invocation cannot
   * heartbeat — so set this safely above the platform's own function timeout.
   * Defaults to 5 minutes.
   */
  ttl?: number;
  /** Resonate server URL, when the execute message does not carry one. */
  url?: string;
  /**
   * This handler's own public base URL. Derived from the request when absent,
   * which is right whenever the request reaches the handler intact. Set it for
   * platforms that rewrite the URL before it arrives.
   */
  baseUrl?: string;
  /** Bearer token for the call back to the server. */
  token?: string;
  /** Resolves credentials per request; overrides `token` when it returns one. */
  auth?: (serverUrl: string | undefined) => Promise<HandlerAuth> | HandlerAuth;
  /** Network request timeout. */
  timeout?: number;
  verbose?: boolean;
  logLevel?: LogLevel;
  logger?: Logger;
  encryptor?: Encryptor;
  prefix?: string;
  /**
   * The execution engine. Defaults to the generator engine's `Core`; pass the
   * async engine's (`@resonatehq/sdk/async`) to run `async` workflows.
   *
   * The two are interchangeable here because both expose the same constructor
   * and the same `onMessage`. Nothing in this file knows which one it holds,
   * which is the reason `handle` is not duplicated per engine the way the
   * platform shells used to be duplicated per platform.
   */
  engine?: CoreConstructor;
}

function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A Resonate worker as a **Web Fetch handler**: `Request` in, `Response` out.
 *
 * That signature is the whole point. It is the interoperable server-runtime
 * handler standardised by Ecma TC55 (WinterTC), so one implementation covers
 * Cloudflare Workers, Deno, Bun, Node 18+, and — through a small envelope
 * adapter — Lambda and Cloud Functions. The platform packages under
 * `packages/` exist to translate *their* envelope into a `Request`; none of
 * them needs to re-implement what happens next, and before this they each did.
 *
 * ```ts
 * const resonate = new ResonateHandler();
 * resonate.register("foo", foo);
 * export default { fetch: (req: Request) => resonate.handle(req) };
 * ```
 *
 * ## Push, not poll
 *
 * This is the receiving half of a **push** deployment. A polling worker holds
 * a connection open and pulls `execute` messages down it; a handler has a URL
 * and the server posts to it. That difference shows up in three places here,
 * and each one is forced rather than chosen:
 *
 * - **No heartbeat** (`NoopHeartbeat`). Nothing survives between requests to
 *   send one from, which is why `ttl` must exceed the platform's function
 *   timeout — the lease is the only thing keeping the task from being
 *   reclaimed mid-flight.
 * - **A network per request**, built from `head.serverUrl`, because the server
 *   that pushed is the server to answer. Only the constructor's `url` is a
 *   fallback, never an override.
 * - **The handler's own URL becomes the dispatch target** for anything this
 *   invocation spawns, so children come back here rather than to a poll group.
 *   That is what `match` below does.
 */
export class ResonateHandler {
  protected registry: Registry;
  protected codec: Codec;
  protected dependencies: Map<string, any>;
  protected logger: Logger;

  private pid: string | undefined;
  private ttl: number;
  private url: string | undefined;
  private baseUrl: string | undefined;
  private token: string | undefined;
  private auth: ResonateHandlerOptions["auth"];
  private timeout: number | undefined;
  private idPrefix: string;
  private engine: CoreConstructor;

  constructor({
    pid = undefined,
    ttl = 5 * 60 * 1000,
    url = undefined,
    baseUrl = undefined,
    token = undefined,
    auth = undefined,
    timeout = undefined,
    verbose = false,
    logLevel = undefined,
    logger = undefined,
    encryptor = undefined,
    prefix = undefined,
    engine = Core,
  }: ResonateHandlerOptions = {}) {
    this.codec = new Codec(encryptor ?? new NoopEncryptor());
    const resolvedPrefix = prefix ?? getEnv("RESONATE_PREFIX");
    this.idPrefix = resolvedPrefix ? `${resolvedPrefix}:` : "";
    this.logger = logger ?? new ConsoleLogger(logLevel ?? (verbose ? "debug" : "warn"));

    this.registry = new Registry();
    this.dependencies = new Map();

    this.pid = pid;
    this.ttl = ttl;
    this.url = url;
    this.baseUrl = baseUrl;
    this.token = token;
    this.auth = auth;
    this.timeout = timeout;
    this.engine = engine;
  }

  /** Registers a function for execution and version control. */
  public register<F extends Func>(name: string, func: F, options?: { version?: number }): void;
  public register<F extends Func>(func: F, options?: { version?: number }): void;
  public register<F extends Func>(
    nameOrFunc: string | F,
    funcOrOptions?: F | { version?: number },
    maybeOptions: { version?: number } = {},
  ): void {
    const { version = 1 } = (typeof funcOrOptions === "object" ? funcOrOptions : maybeOptions) ?? {};
    const func = typeof nameOrFunc === "function" ? nameOrFunc : (funcOrOptions as F);
    const name = typeof nameOrFunc === "string" ? nameOrFunc : func.name;

    this.registry.add(func, name, version);
  }

  /**
   * Registers a named dependency available to every Resonate function via
   * `context.getDependency(name)`.
   */
  public setDependency(name: string, obj: any): void {
    this.dependencies.set(name, obj);
  }

  /**
   * Handles one pushed message.
   *
   * Only `execute` is accepted. `unblock` is addressed to a *listener* — a
   * subscriber waiting on a promise — and there is no task to acquire, so a
   * worker endpoint answering it would be answering the wrong question. It is
   * a 400 here rather than a silent 200 so a misdirected subscription is
   * visible at the point it is misdirected.
   */
  public async handle(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed. Use POST." }, 405);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Request body must be JSON." }, 400);
      }

      if (!isExecuteMsg(body)) {
        return json({ error: "Request body must be a valid execute message." }, 400);
      }

      // The server that pushed is the server to answer. `url` is a fallback,
      // and HttpNetwork falls back again to RESONATE_URL when both are unset —
      // which a Worker may well not have, hence preferring the message.
      const serverUrl = body.head.serverUrl ?? this.url;
      const resolved = this.auth ? await this.auth(serverUrl) : undefined;

      const network = new HttpNetwork({
        url: serverUrl,
        timeout: this.timeout,
        headers: resolved?.headers ?? {},
        token: resolved?.token ?? this.token,
        logger: this.logger,
      });

      const self = this.baseUrl ?? selfUrl(request);

      const core = new this.engine({
        pid: this.pid ?? randomUUID().replace(/-/g, ""),
        ttl: this.ttl,
        clock: new WallClock(),
        send: network.send,
        codec: this.codec,
        registry: this.registry,
        // Nothing lives between requests to beat from.
        heartbeat: new NoopHeartbeat(),
        dependencies: this.dependencies,
        optsBuilder: new OptionsBuilder({
          // A target that is already a URL is honoured as given; anything else
          // — including the SDK's default poll group — is rewritten to this
          // handler, so children of this invocation are pushed back here.
          match: (target: string): string => (isUrl(target) ? target : self),
          idPrefix: this.idPrefix,
        }),
        logger: this.logger,
      });

      const status = await core.onMessage(body);
      return json({ status: status?.kind === "done" ? "completed" : "suspended" }, 200);
    } catch (error) {
      return json({ error: `Handler failed: ${error}` }, 500);
    }
  }
}

/**
 * This handler's public URL, as the outside world would address it.
 *
 * `request.url` is authoritative when the request arrives intact, but behind a
 * proxy or a function URL the scheme and host are in forwarded headers and the
 * URL carries the internal ones. Forwarded values win because the address has
 * to be reachable by the *server*, not by this process.
 */
function selfUrl(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}${url.pathname}`;
}
