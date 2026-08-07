// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// Workflow-side helpers: durable operations expressed through the async
// engine's public Context surface, no engine changes required.

import type { Context, DurablePromise } from "../async/context.js";
import { Options } from "../options.js";
import * as util from "../util.js";

/**
 * Await an EXISTING durable promise by id, durably: the caller suspends until
 * the promise settles and replays to its value afterwards.
 *
 * Encoding: `ctx.rpc` with an explicit id attaches to the existing promise —
 * the create dedups against it (the func name and tags of the create request
 * are ignored for an existing id), a pending record suspends the caller with a
 * callback, a settled record resolves immediately. The callers in this
 * directory only ever attach to ids they know exist, so the create side of the
 * dedup can never fire.
 *
 * This is the one place the prototypes bend the SDK surface: a first-class
 * `ctx.attach(id)` is an obvious SDK addition (NOT a protocol change) and the
 * design document lists it as such.
 */
export function attach<T = any>(ctx: Context, id: string, timeout = 24 * util.HOUR): DurablePromise<T> {
  return ctx.rpc<T>("__attach__", new Options({ id, timeout }));
}
