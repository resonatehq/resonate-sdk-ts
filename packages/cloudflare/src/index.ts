import type { ExecutionContext } from "@cloudflare/workers-types";
import { ResonateHandler, type ResonateHandlerOptions } from "@resonatehq/sdk";

export type { HandlerAuth, ResonateHandlerOptions } from "@resonatehq/sdk";

/**
 * Resonate on Cloudflare Workers.
 *
 * Everything that decides what happens to a pushed `execute` lives in
 * {@link ResonateHandler} in the core SDK, because it is expressed entirely in
 * `Request` and `Response` — the Web Fetch handler standardised by Ecma TC55
 * (WinterTC), which Workers implements natively. This package is what remains
 * once that is factored out: the module-worker export shape, and an
 * initializer hook for Cloudflare's per-request `env`.
 *
 * Prefer `handle` directly — it is the whole interface:
 *
 * ```ts
 * const resonate = new Resonate();
 * resonate.register("foo", foo);
 * export default { fetch: (req: Request) => resonate.handle(req) };
 * ```
 *
 * Use `handlerHttp()` when you need `onInitialize`, which cannot run without
 * `env` and therefore cannot run inside a plain `(Request) => Response`.
 */
export class Resonate extends ResonateHandler {
  private initializer?: (env: Record<string, string>) => Promise<void>;

  constructor(options: ResonateHandlerOptions = {}) {
    super(options);
  }

  /**
   * Runs once per request, before the message is handled, with Cloudflare's
   * `env`. Bindings and secrets only exist there — they are not ambient the
   * way `process.env` is elsewhere — so anything built from them has to be
   * built here rather than in the constructor.
   */
  public onInitialize(fn: (env: Record<string, string>) => Promise<void>): void {
    this.initializer = fn;
  }

  /**
   * The Cloudflare module-worker export.
   *
   * ```ts
   * export default resonate.handlerHttp();
   * ```
   */
  public handlerHttp(): {
    fetch: (request: Request, env: Record<string, string>, ctx: ExecutionContext) => Promise<Response>;
  } {
    return {
      fetch: async (request: Request, env: Record<string, string>, _ctx: ExecutionContext): Promise<Response> => {
        if (this.initializer !== undefined) {
          await this.initializer(env);
        }
        return this.handle(request);
      },
    };
  }
}
