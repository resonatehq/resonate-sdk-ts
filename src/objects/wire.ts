// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// Low-level wire helpers shared by the prototype runtimes. Everything here is
// expressed against the EXISTING protocol surface: promise.create (idempotent,
// first-writer-wins), promise.get, promise.settle (idempotent, first-writer-
// wins), task.create. No protocol extension is required for these helpers —
// they are the userland encoding whose server-native equivalents the design
// document discusses.

import type { Codec } from "../codec.js";
import { isConflict, isSuccess, type PromiseRecord, type Response } from "../network/types.js";
import { randomUUID } from "../platform.js";
import type { Send } from "../types.js";
import * as util from "../util.js";

function head() {
  return { corrId: randomUUID(), version: util.VERSION };
}

function raise(res: Response): never {
  throw new Error(`server error ${res.head.status}: ${JSON.stringify(res.data)}`);
}

/** promise.get returning undefined on 404. */
export async function getPromise(send: Send, codec: Codec, id: string): Promise<PromiseRecord | undefined> {
  const res = await send({ kind: "promise.get", head: head(), data: { id } });
  if (res.head.status === 404) return undefined;
  if (!isSuccess(res)) raise(res);
  return codec.decodePromise(res.data.promise);
}

/**
 * promise.create as compare-and-swap. The server's create is idempotent: an
 * existing id returns the EXISTING record (200), so the caller distinguishes
 * "I won" from "someone else holds this id" by inspecting the returned param.
 */
export async function createPromise(
  send: Send,
  codec: Codec,
  req: { id: string; timeoutAt: number; data: any; tags: Record<string, string> },
): Promise<PromiseRecord> {
  const res = await send({
    kind: "promise.create",
    head: head(),
    data: { id: req.id, timeoutAt: req.timeoutAt, param: codec.encode(req.data), tags: req.tags },
  });
  if (!isSuccess(res)) raise(res);
  return codec.decodePromise(res.data.promise);
}

/**
 * promise.settle as compare-and-swap: settles are first-writer-wins and the
 * server answers 200 with the winning record either way. Returns the settled
 * record; the caller distinguishes winning by inspecting the value.
 */
export async function settlePromise(
  send: Send,
  codec: Codec,
  id: string,
  state: "resolved" | "rejected",
  data: any,
): Promise<PromiseRecord | undefined> {
  const res = await send({
    kind: "promise.settle",
    head: head(),
    data: { id, state, value: codec.encode(data) },
  });
  if (res.head.status === 404) return undefined;
  if (!isSuccess(res)) raise(res);
  return codec.decodePromise(res.data.promise);
}

/**
 * task.create as compare-and-swap activation: creates the promise AND its
 * task in one shot. 409 (promise exists) means another activator won — that
 * is success for our purposes (the object is active or already ran).
 */
export async function createTask(
  send: Send,
  codec: Codec,
  req: { id: string; timeoutAt: number; data: any; tags: Record<string, string>; pid: string; ttl: number },
): Promise<{ created: boolean }> {
  const res = await send({
    kind: "task.create",
    head: head(),
    data: {
      pid: req.pid,
      ttl: req.ttl,
      action: {
        kind: "promise.create",
        head: head(),
        data: { id: req.id, timeoutAt: req.timeoutAt, param: codec.encode(req.data), tags: req.tags },
      },
    },
  });
  if (isConflict(res)) return { created: false };
  if (!isSuccess(res)) raise(res);
  return { created: true };
}

/**
 * Find the first sequence number n >= watermark whose id does not exist yet,
 * assuming the id space is contiguous (ids are only ever created at the
 * current head — the invariant every runtime here maintains). Galloping +
 * binary search: O(log gap) promise.get calls.
 *
 * This probe is the userland cost of having no server-side "append to
 * sequence" primitive; the design document discusses the extension that
 * removes it.
 */
export async function probeHead(send: Send, codec: Codec, idOf: (n: number) => string, watermark = 0): Promise<number> {
  const exists = async (n: number) => (await getPromise(send, codec, idOf(n))) !== undefined;

  const lo = watermark;
  if (!(await exists(lo))) return lo;

  // Gallop: prev exists, search for a missing cur.
  let step = 1;
  let prev = lo;
  let cur = lo + step;
  while (await exists(cur)) {
    prev = cur;
    step *= 2;
    cur = prev + step;
  }

  // First missing index in (prev, cur].
  let a = prev + 1;
  let b = cur;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (await exists(mid)) a = mid + 1;
    else b = mid;
  }
  return a;
}
