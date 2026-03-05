import { WallClock } from "./clock.js";
import { Codec } from "./codec.js";
import type { Context } from "./context.js";
import { Core } from "./core.js";
import { type Encryptor, NoopEncryptor } from "./encryptor.js";
import { NoopHeartbeat } from "./heartbeat.js";
import { HttpNetwork } from "./network/http.js";
import type { ExecuteMsg } from "./network/types.js";
import { OptionsBuilder } from "./options.js";
import { Registry } from "./registry.js";
import type { Func } from "./types.js";
import { buildTransport } from "./util.js";

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): any } | undefined;

export class Resonate {
  private registry = new Registry();
  private dependencies = new Map<string, any>();
  private verbose: boolean;
  private codec: Codec;

  constructor({ verbose = false, encryptor = undefined }: { verbose?: boolean; encryptor?: Encryptor } = {}) {
    this.verbose = verbose;
    this.codec = new Codec(encryptor ?? new NoopEncryptor());
  }

  public register<F extends Func>(
    name: string,
    func: F,
    options?: {
      version?: number;
    },
  ): void;
  public register<F extends Func>(
    func: F,
    options?: {
      version?: number;
    },
  ): void;
  public register<F extends Func>(
    nameOrFunc: string | F,
    funcOrOptions?:
      | F
      | {
          version?: number;
        },
    maybeOptions: {
      version?: number;
    } = {},
  ): void {
    const { version = 1 } = (typeof funcOrOptions === "object" ? funcOrOptions : maybeOptions) ?? {};
    const func = typeof nameOrFunc === "function" ? nameOrFunc : (funcOrOptions as F);
    const name = typeof nameOrFunc === "string" ? nameOrFunc : func.name;

    this.registry.add(func, name, version);
  }

  public setDependency(name: string, obj: any): void {
    this.dependencies.set(name, obj);
  }

  private isExecuteMsg(msg: any): msg is ExecuteMsg {
    return (
      msg &&
      typeof msg === "object" &&
      msg.kind === "execute" &&
      msg.data &&
      typeof msg.data === "object" &&
      msg.data.task &&
      typeof msg.data.task === "object" &&
      typeof msg.data.task.id === "string" &&
      typeof msg.data.task.version === "number" &&
      msg.head &&
      typeof msg.head === "object" &&
      typeof msg.head.serverUrl === "string"
    );
  }

  public async handler(req: Request): Promise<Response> {
    try {
      if (req.method !== "POST") {
        const error = "Method not allowed. Use POST.";
        if (this.verbose) console.error(error);
        return new Response(JSON.stringify({ error }), {
          status: 405,
        });
      }

      const body: any = await req.json();

      if (!body) {
        const error = "Request body missing.";
        if (this.verbose) console.error(error);
        return new Response(JSON.stringify({ error }), {
          status: 400,
        });
      }

      if (!this.isExecuteMsg(body)) {
        const error =
          'Request must be a valid message with "kind": "execute", data.task with id and version, and head.serverUrl.';
        if (this.verbose) console.error(error);
        return new Response(JSON.stringify({ error }), {
          status: 400,
        });
      }

      const clock = new WallClock();
      const network = new HttpNetwork({
        headers: {},
        timeout: 60 * 1000, // 60s
        url: body.head.serverUrl,
      });

      const core = new Core({
        pid: `pid-${Math.random().toString(36).substring(7)}`,
        ttl: 30 * 1000,
        clock,
        send: buildTransport(network, this.verbose).send,
        codec: this.codec,
        registry: this.registry,
        heartbeat: new NoopHeartbeat(),
        dependencies: this.dependencies,
        optsBuilder: new OptionsBuilder({
          match: (_: string): string => req.url,
          idPrefix: "",
        }),
        verbose: this.verbose,
      });

      const res = await core.onMessage(body);
      if (res.kind === "error") throw res.error;
      const result = res.value;

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      const errorMsg = `Handler failed: ${error}`;
      if (this.verbose) console.error(errorMsg);
      return new Response(
        JSON.stringify({
          error: errorMsg,
        }),
        { status: 500 },
      );
    }
  }

  private decrypt(
    res: { status: "completed"; result?: any } | { status: "suspended"; waitingOn: string[] },
  ): { status: "completed"; result?: any } | { status: "suspended"; waitingOn: string[] } {
    if (res.status !== "completed") return res;

    return {
      ...res,
      result: this.codec.decode(res.result),
    };
  }

  public httpHandler(): unknown {
    if (typeof Deno === "undefined") {
      throw new Error("httpHandler requires a Deno runtime (e.g. Supabase Edge Functions)");
    }
    return Deno.serve(async (req: Request) => {
      return await this.handler(req);
    });
  }
}

function buildForwardedURL(req: Request) {
  const headers = req.headers;
  const url = new URL(req.url);

  // 1. Hostname Logic
  // Dev: "x-forwarded-host" is present (e.g., 127.0.0.1)
  // Prod: "x-forwarded-host" is missing, so we use url.hostname (e.g., project.supabase.co)
  const forwardedHost = headers.get("x-forwarded-host");
  const host = forwardedHost ?? url.hostname;

  // 2. Protocol Logic
  // Always prefer "x-forwarded-proto" (usually https in prod), fallback to "http"
  const proto = headers.get("x-forwarded-proto") ?? "http";

  // 3. Port Logic
  // Dev: We need the port (e.g., :54321).
  // Prod: We rarely need :443 explicitly in the URL string.
  const forwardedPort = headers.get("x-forwarded-port");
  const port = forwardedHost && forwardedPort ? `:${forwardedPort}` : "";

  // 4. Path Logic
  // Dev: "x-forwarded-path" contains the full path (/functions/v1/hello-world)
  // Prod: We must use url.pathname.
  let path = headers.get("x-forwarded-path") ?? url.pathname;

  // 5. Production Path Fix
  // In Prod, the internal req.url often strips '/functions/v1'.
  // We re-add it if we are in Prod (no forwardedHost) and it's missing.
  if (!forwardedHost && !path.startsWith("/functions/v1")) {
    path = `/functions/v1${path}`;
  }

  return `${proto}://${host}${port}${path}`;
}

const resonate = new Resonate();

resonate.register("bar", function* (_ctx: Context, name: string): Generator<any, string, any> {
  console.log("running bar");
  return `Hello ${name} from bar`;
});

resonate.register("foo", function* (ctx: Context): Generator<any, void, any> {
  console.log("running foo");

  yield* ctx.run((_ctx: Context) => {
    console.log("running internal function foo, should not repeat this log");
  });

  for (let i = 0; i < 5; i++) {
    const greeting = yield* ctx.rfc("bar", `name-${i}`);
    yield* ctx.run(() => console.log(greeting));
    yield* ctx.sleep(3000);
  }
  yield* ctx.run(function* (_ctx: Context) {
    console.log("done");
  });
});

resonate.httpHandler();
