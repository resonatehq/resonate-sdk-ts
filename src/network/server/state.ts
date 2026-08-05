// =============================================================================
// SERVER STATE — canonical snapshot and change-log fold
// =============================================================================
//
// The machine in `local.ts` is a pure function `(state, req, now) -> { response,
// changes }`. `Change` is its write set: the complete list of effects a request
// had on server state, in the vocabulary of the Lean specification's effects
// table (`setPromise`, `setTask`, `set*Timeout`, `setMessage`, ...).
//
// This module makes that write set *authoritative*. `fold` replays a change log
// into a `Snapshot`, and `snapshot` extracts the same shape directly from a
// running `Server`. The invariant that ties them together —
//
//     fold(every change the server emitted) === snapshot(server)
//
// — is what licenses a durable implementation to treat the change log as the
// commit unit: append the log, and the state is recoverable from it alone. No
// state may live only in the server's heap.
//
// See `tests/network/replay.test.ts`, which asserts the invariant after every
// step of randomized request sequences.

import { type Change, Server, type TimeoutMode } from "../local.js";
import type { Message, PromiseRecord, ScheduleRecord, TaskRecord } from "../types.js";

// A structural view of server state. Keyed collections are plain records rather
// than arrays so that comparison is insensitive to insertion order; the outbox
// stays an array because its order is meaningful.
export interface Snapshot {
  promises: Record<string, PromiseRecord>;
  callbacks: Record<string, string[]>; // awaited id -> awaiter ids
  listeners: Record<string, string[]>; // awaited id -> listener addresses
  tasks: Record<string, TaskRecord>;
  schedules: Record<string, ScheduleRecord>;
  pTimeouts: Record<string, number>;
  tTimeouts: Record<string, { type: number; timeout: number }>;
  sTimeouts: Record<string, number>;
  outbox: { address: string; message: Message }[];
}

export function emptySnapshot(): Snapshot {
  return {
    promises: {},
    callbacks: {},
    listeners: {},
    tasks: {},
    schedules: {},
    pTimeouts: {},
    tTimeouts: {},
    sTimeouts: {},
    outbox: [],
  };
}

/**
 * Apply a single change to a snapshot, in place.
 *
 * This is the reducer that makes the change log replayable. Every branch must
 * be the exact inverse of the corresponding accessor in `Server`; if the two
 * drift, the replay invariant fails and `replay.test.ts` catches it.
 */
export function applyChange(snap: Snapshot, change: Change): void {
  switch (change.kind) {
    case "promise.set": {
      snap.promises[change.promise.id] = change.promise;
      // Callbacks and listeners ride along with the promise they hang off, so
      // that a `promise.set` is a complete statement about that promise. An
      // empty list is a deletion, keeping the snapshot free of empty entries.
      if (change.callbacks.length > 0) {
        snap.callbacks[change.promise.id] = [...change.callbacks];
      } else {
        delete snap.callbacks[change.promise.id];
      }
      if (change.listeners.length > 0) {
        snap.listeners[change.promise.id] = [...change.listeners];
      } else {
        delete snap.listeners[change.promise.id];
      }
      break;
    }
    case "task.set":
      snap.tasks[change.task.id] = change.task;
      break;
    case "schedule.set":
      snap.schedules[change.schedule.id] = change.schedule;
      break;
    case "schedule.del":
      delete snap.schedules[change.id];
      break;
    case "ptimeout.set":
      snap.pTimeouts[change.timeout.id] = change.timeout.timeout;
      break;
    case "ptimeout.del":
      delete snap.pTimeouts[change.id];
      break;
    case "ttimeout.set":
      snap.tTimeouts[change.timeout.id] = { type: change.timeout.type, timeout: change.timeout.timeout };
      break;
    case "ttimeout.del":
      delete snap.tTimeouts[change.id];
      break;
    case "stimeout.set":
      snap.sTimeouts[change.timeout.id] = change.timeout.timeout;
      break;
    case "stimeout.del":
      delete snap.sTimeouts[change.id];
      break;
    case "message.send": {
      // Mirrors `Server.sendMessage`: an execute message supersedes any earlier
      // execute for the same task, because a task is only ever dispatchable at
      // its latest version. Unblock messages accumulate.
      if (change.message.kind === "execute") {
        const taskId = change.message.data.task.id;
        const idx = snap.outbox.findIndex((m) => m.message.kind === "execute" && m.message.data.task.id === taskId);
        if (idx >= 0) {
          snap.outbox[idx] = { address: change.address, message: change.message };
          break;
        }
      }
      snap.outbox.push({ address: change.address, message: change.message });
      break;
    }
    case "outbox.clear":
      snap.outbox = [];
      break;
    case "reset": {
      const fresh = emptySnapshot();
      snap.promises = fresh.promises;
      snap.callbacks = fresh.callbacks;
      snap.listeners = fresh.listeners;
      snap.tasks = fresh.tasks;
      snap.schedules = fresh.schedules;
      snap.pTimeouts = fresh.pTimeouts;
      snap.tTimeouts = fresh.tTimeouts;
      snap.sTimeouts = fresh.sTimeouts;
      snap.outbox = fresh.outbox;
      break;
    }
  }
}

/** Replay a change log into a snapshot, starting from `base` (default empty). */
export function fold(changes: Iterable<Change>, base: Snapshot = emptySnapshot()): Snapshot {
  for (const change of changes) {
    applyChange(base, change);
  }
  return base;
}

/**
 * Extract a snapshot directly from a live `Server`, by reading its heap.
 *
 * This is derived independently of `fold` — one walks the server's maps, the
 * other replays the emitted log — so agreement between them is real evidence
 * that the log is complete rather than a tautology.
 */
export function snapshot(server: Server): Snapshot {
  const snap = emptySnapshot();

  for (const [id, p] of server.promises) {
    const { callbacks, listeners, settledAt, ...rest } = p;
    snap.promises[id] = settledAt != null ? { ...rest, settledAt } : rest;
    if (callbacks.size > 0) snap.callbacks[id] = [...callbacks];
    if (listeners.size > 0) snap.listeners[id] = [...listeners];
  }

  for (const [id, t] of server.tasks) {
    const record: TaskRecord = { id: t.id, version: t.version, state: t.state, resumes: [...t.resumes] };
    if (t.pid !== undefined) record.pid = t.pid;
    if (t.ttl !== undefined) record.ttl = t.ttl;
    snap.tasks[id] = record;
  }

  for (const [id, s] of server.schedules) {
    const st = server.sTimeouts.find((e) => e.id === id);
    const record: ScheduleRecord = {
      id: s.id,
      cron: s.cron,
      promiseId: s.promiseId,
      promiseTimeout: s.promiseTimeout,
      promiseParam: s.promiseParam,
      promiseTags: s.promiseTags,
      createdAt: s.createdAt,
      // A schedule always has a pending timeout while it exists; `Server`
      // relies on the same invariant in `toScheduleRecord`.
      nextRunAt: st!.timeout,
    };
    if (s.lastRunAt != null) record.lastRunAt = s.lastRunAt;
    snap.schedules[id] = record;
  }

  for (const pt of server.pTimeouts) snap.pTimeouts[pt.id] = pt.timeout;
  for (const tt of server.tTimeouts) snap.tTimeouts[tt.id] = { type: tt.type, timeout: tt.timeout };
  for (const st of server.sTimeouts) snap.sTimeouts[st.id] = st.timeout;

  snap.outbox = server.outgoing.map((m) => ({ address: m.address, message: m.message }));

  return snap;
}

/**
 * Rebuild a live `Server` from a snapshot — the inverse of {@link snapshot}.
 *
 * This is process recovery: a runtime that lost its heap loads the last
 * checkpoint, folds the log tail onto it, and hydrates a machine that must be
 * indistinguishable from the one that died. `tests/network/replay.test.ts`
 * asserts exactly that, by driving a recovered machine and the original with
 * the same requests and comparing responses step by step.
 */
export function hydrate(snap: Snapshot, opts: { timeoutMode?: TimeoutMode } = {}): Server {
  const server = new Server(opts);

  for (const [id, record] of Object.entries(snap.promises)) {
    server.promises.set(id, {
      id: record.id,
      state: record.state,
      param: record.param,
      value: record.value,
      tags: record.tags,
      timeoutAt: record.timeoutAt,
      createdAt: record.createdAt,
      // `Promise` stores an explicit null where the wire record omits the field.
      settledAt: record.settledAt ?? null,
      callbacks: new Set(snap.callbacks[id] ?? []),
      listeners: new Set(snap.listeners[id] ?? []),
    });
  }

  for (const [id, record] of Object.entries(snap.tasks)) {
    server.tasks.set(id, {
      id: record.id,
      state: record.state,
      version: record.version,
      pid: record.pid,
      ttl: record.ttl,
      // `resumes` is typed as a union on the wire; only the array form is ever
      // produced by this machine.
      resumes: new Set(Array.isArray(record.resumes) ? record.resumes : []),
    });
  }

  for (const [id, record] of Object.entries(snap.schedules)) {
    server.schedules.set(id, {
      id: record.id,
      cron: record.cron,
      promiseId: record.promiseId,
      promiseTimeout: record.promiseTimeout,
      promiseParam: record.promiseParam,
      promiseTags: record.promiseTags,
      createdAt: record.createdAt,
      // `nextRunAt` is not stored on the schedule; it is derived from sTimeouts.
      lastRunAt: record.lastRunAt,
    });
  }

  server.pTimeouts = Object.entries(snap.pTimeouts).map(([id, timeout]) => ({ id, timeout }));
  server.tTimeouts = Object.entries(snap.tTimeouts).map(([id, t]) => ({
    id,
    type: t.type as 0 | 1,
    timeout: t.timeout,
  }));
  server.sTimeouts = Object.entries(snap.sTimeouts).map(([id, timeout]) => ({ id, timeout }));
  server.outgoing = snap.outbox.map((m) => ({ address: m.address, message: m.message }));

  return server;
}
