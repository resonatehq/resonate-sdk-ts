// =============================================================================
// DOCUMENT
// =============================================================================
//
// One workflow (origin) = one JSON document under one key.
//
// The protocol guarantees a callback never crosses an origin, so every request
// reads and writes exactly one workflow's state. A workflow is a unit of
// consistency, and here it becomes a unit of storage: everything the protocol
// touches while advancing one workflow — its promises, the callbacks and
// listeners registered against them, its tasks, buffered resumes, and the
// armed timeouts — lives in one document, and every transition is one
// conditional PUT of that document.
//
// The document is the atomicity domain. There is no log, no claim, no fencing:
// concurrency control is the ETag. A writer GETs the document, decides in
// memory, and PUTs conditionally (`If-None-Match: *` to create, `If-Match` to
// replace). A zombie writer is not fenced; its PUT simply fails.
//
// Lists are flat and append-ordered — the spec's `seq` is the array index.
// Lookups rebuild whatever access path they need on the fly; a workflow's
// live state is small, so linear scans are the simple thing that works.

import type { PromiseRecord, TaskRecord, Value } from "../types.js";

/** Bumped when the document layout changes in a way old documents cannot satisfy. */
export const DOC_VERSION = 1;

export interface PromiseDoc {
  id: string;
  state: PromiseRecord["state"];
  param?: Value;
  value?: Value;
  tags: Record<string, string>;
  /** Derived from tags at creation, stored so every read agrees: `resonate:target`. */
  target: string | null;
  /** `resonate:branch`, for preloads. */
  branch: string | null;
  /** `resonate:timer` — a timer resolves (not rejects) at its deadline. */
  timer: boolean;
  /** Tagged external, targeted, or a timer: may be awaited, arms a durable timeout. */
  external: boolean;
  timeoutAt: number;
  createdAt: number;
  settledAt: number | null;
}

export interface TaskDoc {
  id: string;
  state: TaskRecord["state"];
  version: number;
  pid: string | null;
  ttl: number | null;
}

/** Task timeout kinds within a document (the spec's `setTaskTimeout` key). */
export const TASK_TIMEOUT_RETRY = 0;
export const TASK_TIMEOUT_LEASE = 1;

/** Landed-step nonces kept in a document for write recognition. */
export const JOURNAL_CAP = 16;

export interface OriginDoc {
  v: number;
  /**
   * The nonces of the last `JOURNAL_CAP` landed steps, oldest first.
   *
   * Byte equality recognizes a write of unknown fate only while the document
   * still holds exactly our bytes; once a rival lands on top, the evidence
   * is gone and a step that really executed would be disowned and re-decided
   * — answering, say, 409 for an acquire that took effect, an effect no
   * response then explains. The journal keeps the evidence: a step whose
   * nonce appears in the current document landed, however many writes ago.
   */
  journal?: string[];
  promises: PromiseDoc[];
  /** Awaiters registered against an awaited promise, in registration order. */
  callbacks: { awaited: string; awaiter: string }[];
  listeners: { promise: string; address: string }[];
  tasks: TaskDoc[];
  /** Awaited ids that settled while the task was not suspended, in order. */
  resumes: { task: string; awaited: string }[];
  promiseTimeouts: { id: string; timeoutAt: number }[];
  /** kind 0 = pending retry, kind 1 = lease expiration. */
  taskTimeouts: { id: string; kind: number; timeoutAt: number }[];
}

export function emptyDoc(): OriginDoc {
  return {
    v: DOC_VERSION,
    promises: [],
    callbacks: [],
    listeners: [],
    tasks: [],
    resumes: [],
    promiseTimeouts: [],
    taskTimeouts: [],
  };
}

export function encodeDoc(doc: OriginDoc): string {
  return JSON.stringify(doc);
}

export function decodeDoc(body: string): OriginDoc {
  const doc = JSON.parse(body) as OriginDoc;
  if (typeof doc !== "object" || doc === null || typeof doc.v !== "number") {
    throw new Error("Malformed origin document");
  }
  if (doc.v > DOC_VERSION) {
    throw new Error(`Origin document is at version ${doc.v}, newer than this SDK understands (${DOC_VERSION})`);
  }
  return doc;
}

/** One armed timer, as the timeout bucket indexes it. */
export interface ArmedTimer {
  id: string;
  /** The timeout bucket's widened encoding: 0 promise, 1 task retry, 2 task lease. */
  kind: number;
  timeoutAt: number;
}

/** The tenant-wide timeout index's kind encoding. */
export const TIMEOUT_PROMISE = 0;
export const TIMEOUT_TASK_RETRY = 1;
export const TIMEOUT_TASK_LEASE = 2;
/** A schedule's next-run entry — not armed by any document, keyed by schedule id. */
export const TIMEOUT_SCHEDULE = 3;

/** Every armed timer in a document, in the index's kind encoding. */
export function armedTimers(doc: OriginDoc): ArmedTimer[] {
  return [
    ...doc.promiseTimeouts.map((t) => ({ id: t.id, kind: TIMEOUT_PROMISE, timeoutAt: t.timeoutAt })),
    ...doc.taskTimeouts.map((t) => ({
      id: t.id,
      kind: t.kind === TASK_TIMEOUT_LEASE ? TIMEOUT_TASK_LEASE : TIMEOUT_TASK_RETRY,
      timeoutAt: t.timeoutAt,
    })),
  ];
}
