// =============================================================================
// STORE
// =============================================================================
//
// Two buckets, one loop.
//
// The WORKFLOW bucket holds one document per origin. Every transition is one
// pass of the update loop: GET the document, decide in memory, and PUT it back
// conditionally — `If-None-Match: *` to create, `If-Match: <etag>` to replace.
// On conflict, re-get and re-decide. There is no lock, no lease on the
// document, no fencing: a zombie writer's PUT simply fails. A step that
// changes nothing writes nothing (the write law), which is what keeps
// steady-state reads a single GET.
//
// The TIMEOUT bucket is the fleet's discovery mechanism: one small document
// per armed wakeup, keyed by TIME BUCKET — `t/<YYYY-MM-DDTHH:MM>/...`, minute
// precision, UTC — so lexicographic key order IS chronological order and a
// sweeper lists oldest-first, stopping at the present. Entries are HINTS
// about when to look where; the workflow document remains the truth about
// what is due. But their durability is hard: a lost entry is a lost wakeup,
// recoverable only by scanning every document. Hence:
//
//   THE COVERAGE LAW — for every armed deadline in any landed document, an
//   entry at (a bucket <= that deadline, that origin) exists. Enforced by
//   phase order: when a step moves an origin's earliest armed deadline, the
//   entry is written BEFORE the document. If the entry cannot be made
//   durable, the step fails CLOSED — no put without a durable wakeup.
//
//   THE DELTA RULE — a step arms an entry iff it changed the origin's minimum
//   armed deadline. A fire that re-arms changes the minimum and so re-arms
//   its own cover before its put; an unchanged minimum keeps the prior,
//   not-yet-completed entry as cover.
//
//   FIRE THEN COMPLETE — the sweeper deletes an entry only after the tick it
//   fired has landed, and only when the document's new minimum lives in a
//   different time bucket (otherwise the entry still covers). A crash between
//   fire and complete leaves the entry; the next sweep re-fires; ticks are
//   idempotent by the write law. Spurious entries, duplicates, and stale
//   entries are all safe — a consumer re-validates against the document and
//   an early fire refuses (the spec's NOT BEFORE rule). Only loss is
//   forbidden.
//
// Entries are deleted as they are consumed, so the listing stays O(armed
// wakeups) — cost control is deletion discipline, not listing bounds.

import type { Logger } from "../../logger.js";
import { randomUUID } from "../../platform.js";
import { armedTimers, decodeDoc, emptyDoc, encodeDoc, JOURNAL_CAP, type OriginDoc } from "./document.js";
import type { PutResult, S3Bucket } from "./driver.js";
import { hashOrigin, OriginServer, type OutgoingMessage, type ScheduleDoc } from "./server.js";

/** Re-decides allowed per step before giving up (bounded livelock). */
const MAX_RETRIES = 64;

// =============================================================================
// KEYS
// =============================================================================

/**
 * The minute-precision UTC time bucket a deadline falls in, shaped so that
 * lexicographic order is chronological order: `YYYY-MM-DDTHH:MM`.
 */
export function minuteBucket(ms: number): string {
  return new Date(Math.max(0, ms)).toISOString().slice(0, 16);
}

/** Path-safe encoding of an origin or schedule id for use inside a key. */
function enc(name: string): string {
  return encodeURIComponent(name);
}

export function workflowKey(origin: string): string {
  return `wf/${enc(origin)}`;
}

/** A wakeup entry for an origin's earliest armed deadline. */
export function originEntryKey(at: number, origin: string): string {
  return `t/${minuteBucket(at)}/o/${enc(origin)}`;
}

/** A wakeup entry for a schedule's next run. */
export function scheduleEntryKey(at: number, scheduleId: string): string {
  return `t/${minuteBucket(at)}/s/${enc(scheduleId)}`;
}

export function scheduleKey(id: string): string {
  return `sched/${enc(id)}`;
}

/** A parsed wakeup entry. */
export interface SweepEntry {
  key: string;
  bucket: string;
  kind: "origin" | "schedule";
  /** The origin, or the schedule id. */
  name: string;
}

export function parseEntryKey(key: string): SweepEntry | null {
  const match = /^t\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\/([os])\/(.+)$/.exec(key);
  if (!match) return null;
  try {
    return {
      key,
      bucket: match[1],
      kind: match[2] === "o" ? "origin" : "schedule",
      name: decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

/** The earliest armed deadline in a document, or null when nothing is armed. */
export function minDeadline(doc: OriginDoc): number | null {
  let min: number | null = null;
  for (const t of armedTimers(doc)) {
    if (min === null || t.timeoutAt < min) min = t.timeoutAt;
  }
  return min;
}

// =============================================================================
// STORE
// =============================================================================

export interface S3StoreConfig {
  /** The workflow documents. An S3 Express directory bucket fits best. */
  workflows: S3Bucket;
  /** The wakeup entries and schedules. MUST be a general purpose bucket (ordered listing). */
  timeouts: S3Bucket;
  retryTimeout: number;
  logger?: Logger;
}

/** What one landed step reports. */
export interface StepResult<T> {
  value: T;
  messages: OutgoingMessage[];
}

export class S3Store {
  /** Serializes steps per origin within this process, so a node does not conflict with itself. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly cfg: S3StoreConfig) {}

  withLock<T>(origin: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(origin) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but never let a rejection escape into the next link.
    this.locks.set(
      origin,
      next.catch(() => {}),
    );
    return next;
  }

  // ---------------------------------------------------------------------------
  // THE UPDATE LOOP
  // ---------------------------------------------------------------------------

  /**
   * Run one step against an origin: get, decide, put-if, and on conflict
   * re-get and re-decide. `fn` must be safe to re-run — it is invoked once per
   * attempt, each time against a fresh copy of the stored document.
   *
   * Messages are collected from the attempt that LANDED (or that decided not
   * to write); a conflicted attempt's messages are discarded with its
   * document, so a message is only ever delivered for a state change that
   * actually happened.
   */
  async updateOrigin<T>(
    origin: string,
    now: number,
    fn: (server: OriginServer, doc: OriginDoc) => T,
  ): Promise<StepResult<T>> {
    return await this.withLock(origin, () => this.step(origin, now, fn));
  }

  private async step<T>(
    origin: string,
    now: number,
    fn: (server: OriginServer, doc: OriginDoc) => T,
  ): Promise<StepResult<T>> {
    const key = workflowKey(origin);
    let current = await this.cfg.workflows.get(key);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const before: OriginDoc = current ? decodeDoc(current.body) : emptyDoc();
      const doc: OriginDoc = current ? decodeDoc(current.body) : emptyDoc();

      const server = new OriginServer(doc, now, this.cfg.retryTimeout);
      const value = fn(server, doc);
      const messages = server.takeMessages();

      // The write law: a step that changed nothing writes nothing — judged
      // with the journal held constant, or bookkeeping would turn every read
      // into a write. A fresh, still-empty document is the same case.
      const unchanged = encodeDoc(doc);
      if ((current && unchanged === current.body) || (!current && unchanged === encodeDoc(emptyDoc()))) {
        return { value, messages };
      }

      // This attempt writes: stamp its nonce into the journal, so the write
      // stays recognizable as ours even after rivals land on top of it.
      const nonce = randomUUID();
      doc.journal = [...(before.journal ?? []), nonce].slice(-JOURNAL_CAP);
      const next = encodeDoc(doc);

      // THE COVERAGE LAW, enforced by phase order: if this step moved the
      // origin's earliest armed deadline, its wakeup entry must be durable
      // BEFORE the document lands. Fail closed if it cannot be.
      const minBefore = minDeadline(before);
      const minAfter = minDeadline(doc);
      if (minAfter !== null && minAfter !== minBefore) {
        await this.armEntry(originEntryKey(minAfter, origin), { at: minAfter, origin });
      }

      const result = await this.cfg.workflows.put(
        key,
        next,
        current ? { kind: "replace", ifMatch: current.etag } : { kind: "create" },
      );

      const landed = await this.resolvePut(key, next, nonce, result);
      if (landed === "landed") return { value, messages };

      // Conflict: someone else moved the document. Re-decide against theirs.
      current = landed;
    }

    throw new Error(`conflict storm on origin ${JSON.stringify(origin)}: ${MAX_RETRIES} re-decides exhausted`);
  }

  /**
   * Resolve a conditional PUT's report into "landed" or the fresher object to
   * re-decide against.
   *
   * An `unknown` outcome (the bytes may or may not have reached the store) is
   * resolved by re-reading and RECOGNIZING our own write, two ways:
   *
   *   * byte equality — the store holds exactly our bytes; identical bytes
   *     are identical state, so the one false positive (someone else produced
   *     exactly our bytes) is an idempotent race whose correct response is
   *     the one we are already holding;
   *   * the journal — the store has moved past our bytes, but the current
   *     document's journal carries this attempt's nonce, which proves our
   *     write landed and rivals built on it. Disowning it there and
   *     re-deciding would repeat a step that already took effect — and
   *     answer, say, 409 for an acquire that actually won (found by the
   *     linearizability checker under an adversarial store).
   *
   * A `conflict` needs neither: the driver surfaces conflicts only as the
   * store's own answer to exactly this attempt (no transport retries), so a
   * conflicted attempt is known not to have landed.
   */
  private async resolvePut(
    key: string,
    intended: string,
    nonce: string,
    result: PutResult,
  ): Promise<"landed" | { body: string; etag: string } | null> {
    if (result.kind === "landed") return "landed";

    const fresh = await this.cfg.workflows.get(key);
    if (fresh && fresh.body === intended) return "landed";
    if (result.kind === "conflict") return fresh;

    if (fresh) {
      try {
        if (decodeDoc(fresh.body).journal?.includes(nonce)) return "landed";
      } catch {
        /* an undecodable rival document is a conflict to re-decide against */
      }
    }

    // The attempt's fate was unknown and the store holds no evidence of it:
    // treat it like a conflict and re-decide, which also covers the case
    // where the write never left the building.
    this.cfg.logger?.warn({ component: "network", key, error: result.error }, "s3 put outcome unknown, re-deciding");
    return fresh;
  }

  /**
   * Make one wakeup entry durable, failing closed.
   *
   * Entries are create-only: a key collision means an entry for this minute
   * and name already exists, which covers us just as well — the sweeper gates
   * on the bucket, not the body. An unknown outcome is resolved by reading
   * the key back; only proven presence lets the step proceed. The put is
   * idempotent, so a transient failure is retried (bounded) before the step
   * fails closed — no document put without a durable wakeup.
   */
  private async armEntry(key: string, body: { at: number; origin?: string; schedule?: string }): Promise<void> {
    let error = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await this.cfg.timeouts.put(key, JSON.stringify(body), { kind: "create" });
      if (result.kind === "landed" || result.kind === "conflict") return;
      error = result.error;
      const readBack = await this.cfg.timeouts.get(key);
      if (readBack !== null) return;
    }
    // FAIL CLOSED.
    throw new Error(`could not arm wakeup entry ${key}: ${error}`);
  }

  /** Read an origin's document without stepping it. `null` when it has none. */
  async readOrigin(origin: string): Promise<OriginDoc | null> {
    const found = await this.cfg.workflows.get(workflowKey(origin));
    return found ? decodeDoc(found.body) : null;
  }

  // ---------------------------------------------------------------------------
  // SWEEP
  // ---------------------------------------------------------------------------

  /**
   * The due wakeup entries, oldest bucket first.
   *
   * Lists the `t/` prefix in key order and STOPS at the first entry whose
   * bucket is past `now` — the ordering guarantee this bucket class was
   * chosen for. An entry in the current minute is returned even if its exact
   * deadline is seconds ahead: firing early is safe (every transition
   * re-checks its own due time; a too-early tick changes nothing and the
   * entry survives to be swept again).
   *
   * A sharded node takes only its own slice — `hashOrigin(name) % count ===
   * index` — so a crowded fleet's entries do not fill its batch with wakeups
   * belonging to someone else.
   */
  async dueEntries(
    now: number,
    shard: { index: number; count: number } | undefined,
    batch: number,
  ): Promise<SweepEntry[]> {
    const horizon = minuteBucket(now);
    const due: SweepEntry[] = [];
    let startAfter: string | undefined;

    while (due.length < batch) {
      const page = await this.cfg.timeouts.list("t/", { startAfter, limit: 1000 });
      let past = false;
      for (const key of page.keys) {
        const entry = parseEntryKey(key);
        if (!entry) continue;
        if (entry.bucket > horizon) {
          past = true;
          break;
        }
        if (shard && hashOrigin(entry.name) % shard.count !== shard.index) continue;
        due.push(entry);
        if (due.length >= batch) break;
      }
      if (past || !page.truncated || page.keys.length === 0) break;
      startAfter = page.keys[page.keys.length - 1];
    }

    return due;
  }

  /**
   * Complete a fired entry: delete it, unless the document's new minimum
   * deadline still falls in the entry's own bucket — then the entry is still
   * this document's cover and must survive.
   */
  async completeEntry(entry: SweepEntry, newMin: number | null): Promise<void> {
    if (newMin !== null && minuteBucket(newMin) === entry.bucket) return;
    await this.cfg.timeouts.delete(entry.key);
  }

  // ---------------------------------------------------------------------------
  // SCHEDULES
  // ---------------------------------------------------------------------------

  async getSchedule(id: string): Promise<{ doc: ScheduleDoc; etag: string } | null> {
    const found = await this.cfg.timeouts.get(scheduleKey(id));
    return found ? { doc: JSON.parse(found.body) as ScheduleDoc, etag: found.etag } : null;
  }

  /**
   * Create a schedule, arming its first-run entry FIRST — the coverage law
   * applies to schedules too: a stored schedule with no entry would never
   * fire. Returns the stored schedule, which is the existing one when the
   * create loses an idempotent race.
   */
  async createSchedule(doc: ScheduleDoc): Promise<{ doc: ScheduleDoc; created: boolean }> {
    await this.armEntry(scheduleEntryKey(doc.nextRunAt, doc.id), { at: doc.nextRunAt, schedule: doc.id });
    const result = await this.cfg.timeouts.put(scheduleKey(doc.id), JSON.stringify(doc), { kind: "create" });
    if (result.kind === "landed") return { doc, created: true };
    const existing = await this.getSchedule(doc.id);
    if (existing) return { doc: existing.doc, created: false };
    if (result.kind === "unknown") throw new Error(`could not create schedule ${doc.id}: ${result.error}`);
    // Conflict against a schedule that is now gone: a concurrent delete won.
    return { doc, created: false };
  }

  /**
   * Advance a schedule past a fired occurrence, arming the next run's entry
   * before the advance lands. A conflict means another sweeper advanced it —
   * occurrences are idempotent, so losing the race is fine.
   */
  async advanceSchedule(doc: ScheduleDoc, etag: string, lastRunAt: number, nextRunAt: number): Promise<void> {
    await this.armEntry(scheduleEntryKey(nextRunAt, doc.id), { at: nextRunAt, schedule: doc.id });
    const advanced: ScheduleDoc = { ...doc, lastRunAt, nextRunAt };
    const result = await this.cfg.timeouts.put(scheduleKey(doc.id), JSON.stringify(advanced), {
      kind: "replace",
      ifMatch: etag,
    });
    if (result.kind === "unknown") {
      this.cfg.logger?.warn(
        { component: "network", schedule: doc.id, error: result.error },
        "s3 schedule advance outcome unknown; the next sweep re-fires idempotently",
      );
    }
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.cfg.timeouts.delete(scheduleKey(id));
  }

  /** Every stored schedule, in id order. The search surface is small by design. */
  async listSchedules(): Promise<ScheduleDoc[]> {
    const docs: ScheduleDoc[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.cfg.timeouts.list("sched/", { startAfter, limit: 1000 });
      for (const key of page.keys) {
        const found = await this.cfg.timeouts.get(key);
        if (found) docs.push(JSON.parse(found.body) as ScheduleDoc);
      }
      if (!page.truncated || page.keys.length === 0) break;
      startAfter = page.keys[page.keys.length - 1];
    }
    return docs;
  }

  // ---------------------------------------------------------------------------
  // RESET (test support)
  // ---------------------------------------------------------------------------

  /** Delete every object in both buckets. Test support only. */
  async reset(): Promise<void> {
    for (const bucket of [this.cfg.workflows, this.cfg.timeouts]) {
      for (;;) {
        const page = await bucket.list("", { limit: 1000 });
        for (const key of page.keys) await bucket.delete(key);
        if (!page.truncated) break;
      }
    }
    this.locks.clear();
  }
}
