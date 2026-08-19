// Equivalence oracle.
//
// Both SDK engines (the generator engine in `src/` and the async engine in
// `src/async/`) are thin drivers over the SAME shared server. The server's
// durable state — the promise store, task store, and callback set — is the only
// thing that survives a crash, so it is the ground truth for "behavior". Two
// runs are equivalent iff their canonicalized server snapshots are deep-equal
// AND their observed root outcome matches.
//
// This module pulls that state out via the server's `debug.snap` request (which
// `LocalConnection.send` routes straight to the server) and projects it into a
// stable, engine-independent shape: decoded payloads, non-deterministic fields
// stripped, everything sorted.

import type { Network } from "@resonatehq/base";
import { type DebugSnapRes, isSuccess } from "@resonatehq/base";
import { Codec } from "../../src/codec.js";
import { VERSION } from "../../src/util.js";

const codec = new Codec();

type Snap200 = Extract<DebugSnapRes, { head: { status: 200 } }>["data"];

export type SnapMode = "wallclock" | "stepclock";

/** Tags that legitimately differ between the engines and are excluded from the
 * canonical projection. Currently empty: `resonate:prefix` used to be excluded
 * (former divergence #5) but the async engine now sets and propagates it
 * identically, so it is compared like every other tag. */
const DEFAULT_STRIP_TAGS: string[] = [];

export type CanonPromise = {
  id: string;
  state: string;
  param: unknown;
  value: unknown;
  tags: Record<string, string>;
};

export type CanonTask = {
  id: string;
  state: string;
  resumes: string[] | number | boolean;
};

export type CanonSnapshot = {
  promises: CanonPromise[];
  tasks: CanonTask[];
  callbacks: { awaiter: string; awaited: string }[];
};

export type Outcome = { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };

/** Reads the full durable state out of the server behind a network. */
export async function rawSnapshot(network: Network): Promise<Snap200> {
  const res = await network.send({
    kind: "debug.snap",
    head: { corrId: "equivalence-snap", version: VERSION },
    data: {},
  });
  if (!isSuccess(res)) {
    throw new Error(`debug.snap failed: ${res.head.status} ${String(res.data)}`);
  }
  return res.data;
}

/** Replaces Error instances with a stable `{name, message}` shape so payloads
 * compare by identity-free content (no stacks, no prototype quirks). */
export function normalizeErrors(value: unknown): unknown {
  if (value instanceof Error) {
    return { __error: { name: value.name, message: value.message } };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeErrors);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeErrors((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonTags(tags: Record<string, string>, strip: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(tags).sort()) {
    if (strip.has(key)) continue;
    out[key] = tags[key];
  }
  return out;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Projects a raw `debug.snap` payload into a stable, engine-independent shape.
 *
 * - Decodes `param`/`value` so we compare logical payloads, not base64.
 * - Normalizes Errors to `{name, message}` (no stacks).
 * - Strips wall-clock fields (always in `wallclock` mode; in `stepclock` mode
 *   absolute time still diverges between engines because each emits a different
 *   number of messages → ticks → clock reads, so it is stripped there too and
 *   asserted separately as a per-run invariant).
 * - Strips any caller-supplied tags and sorts everything.
 *
 * The strong oracle is promises + tasks + callbacks. Listeners and outbound
 * messages are excluded: they reflect harness-level subscription and
 * eager-vs-lazy message counts, not engine semantics.
 */
export function canonicalize(snap: Snap200, opts: { mode: SnapMode; stripTags?: string[] }): CanonSnapshot {
  const strip = new Set([...DEFAULT_STRIP_TAGS, ...(opts.stripTags ?? [])]);

  const promises: CanonPromise[] = snap.promises
    .map((p) => {
      const decoded = codec.decodePromise(p);
      return {
        id: p.id,
        state: p.state,
        param: normalizeErrors(decoded.param?.data),
        value: normalizeErrors(decoded.value?.data),
        tags: canonTags(p.tags, strip),
      };
    })
    .sort(byId);

  // Task `version` (the fencing epoch) is intentionally excluded: it counts how
  // many times the task was acquired/resumed, which legitimately differs between
  // the engines' suspend/resume granularity and is timing-sensitive (e.g. how a
  // sleep timer lines up with the server tick). The durable promise store is the
  // behavior that matters; task epoch is internal bookkeeping.
  const tasks: CanonTask[] = snap.tasks.map((t) => ({ id: t.id, state: t.state, resumes: t.resumes })).sort(byId);

  const callbacks = snap.callbacks
    .map((c) => ({ awaiter: c.awaiter, awaited: c.awaited }))
    .sort((a, b) => {
      const ka = `${a.awaited}\u0000${a.awaiter}`;
      const kb = `${b.awaited}\u0000${b.awaiter}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  return { promises, tasks, callbacks };
}

/** Runs a result()-style promise to completion and captures the outcome. */
export async function captureOutcome(p: Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: "resolved", value: normalizeErrors(await p) };
  } catch (e) {
    return { kind: "rejected", error: normalizeErrors(e) };
  }
}
