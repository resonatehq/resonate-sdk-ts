// =============================================================================
// LIVE NATS BINDINGS
// =============================================================================
//
// Adapters from `@nats-io/jetstream` to the narrow interfaces the log and timer
// are written against. Every call here is exercised by
// `tests/network/nats-integration.test.ts` against a real nats-server; run it
// with RESONATE_NATS_URL set.
//
// Types are declared structurally rather than imported, so the SDK keeps no
// hard dependency on the optional `@nats-io/jetstream` package.

import type { JsBinding } from "./jetstream.js";
import { ConflictError } from "./log.js";
import type { JsTimerBinding } from "./nats-timer.js";
import { SCHEDULE_HEADER } from "./nats-timer.js";

/** Error code nats-server returns when a publish expectation fails. */
export const WRONG_LAST_SEQUENCE = 10071;

export interface JsLike {
  publish(subject: string, payload?: Uint8Array, opts?: Record<string, unknown>): Promise<{ seq: number }>;
}

export interface JsmLike {
  streams: {
    info(name: string, opts?: Record<string, unknown>): Promise<{ state: { subjects?: Record<string, number> } }>;
    getMessage(
      name: string,
      query: Record<string, unknown>,
    ): Promise<{ seq: number; data: Uint8Array; header?: { get(k: string): string } } | null>;
    purge(name: string, opts?: Record<string, unknown>): Promise<unknown>;
    deleteMessage?(name: string, seq: number): Promise<boolean>;
  };
  consumers: { add(stream: string, cfg: Record<string, unknown>): Promise<unknown> };
}

/** True when `err` is nats-server rejecting a failed publish expectation. */
export function isWrongLastSequence(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  // The API error code is the reliable signal; the message is a fallback for
  // client versions that do not surface the code.
  if (Number(e?.code) === WRONG_LAST_SEQUENCE) return true;
  return typeof e?.message === "string" && /wrong last sequence/i.test(e.message);
}

/**
 * A JetStream-backed {@link JsBinding} for the origin log.
 *
 * `fetch` reads forward by sequence using `getMessage({ seq, next_by_subj })`,
 * which walks a subject without needing a consumer.
 */
export function jetStreamLogBinding(js: JsLike, jsm: JsmLike, stream: string): JsBinding {
  return {
    async publish(subject, payload, expectLastSubjectSeq) {
      try {
        const ack = await js.publish(subject, payload, {
          expect: { lastSubjectSequence: expectLastSubjectSeq },
        });
        return ack.seq;
      } catch (err) {
        if (isWrongLastSequence(err)) {
          throw new ConflictError(subject, expectLastSubjectSeq, -1);
        }
        throw err;
      }
    },

    async fetch(subject, fromSeq) {
      const out: { seq: number; payload: Uint8Array }[] = [];
      let cursor = fromSeq + 1;
      while (true) {
        let msg: { seq: number; data: Uint8Array } | null;
        try {
          msg = await jsm.streams.getMessage(stream, { seq: cursor, next_by_subj: subject });
        } catch {
          // No message at or after the cursor on this subject.
          break;
        }
        if (!msg) break;
        out.push({ seq: msg.seq, payload: msg.data });
        cursor = msg.seq + 1;
      }
      return out;
    },

    async lastSeq(subject) {
      try {
        const msg = await jsm.streams.getMessage(stream, { last_by_subj: subject });
        return msg?.seq ?? 0;
      } catch {
        return 0;
      }
    },

    async purgeUpTo(subject, _throughSeq) {
      // `keep: 1` is what preserves the subject: an empty subject vanishes from
      // `state.subjects`, and an origin the runtime cannot enumerate is a
      // lineage whose timers can never fire again.
      await jsm.streams.purge(stream, { filter: subject, keep: 1 });
    },

    async subjects(prefix) {
      const info = await jsm.streams.info(stream, { subjects_filter: `${prefix}.>` });
      return Object.keys(info.state.subjects ?? {});
    },
  };
}

/** A JetStream-backed {@link JsTimerBinding} using broker message schedules. */
export function jetStreamTimerBinding(js: JsLike, jsm: JsmLike, stream: string): JsTimerBinding {
  return {
    async schedule(subject, target, at) {
      // Publishing to a subject that already carries a schedule replaces it,
      // which is the re-arm the runtime performs on every commit.
      await js.publish(subject, new TextEncoder().encode(target), {
        schedule: { specification: new Date(at), target },
      });
    },

    async cancel(subject) {
      await jsm.streams.purge(stream, { filter: subject });
    },

    async scheduledAt(subject) {
      let msg: { header?: { get(k: string): string } } | null;
      try {
        msg = await jsm.streams.getMessage(stream, { last_by_subj: subject });
      } catch {
        return undefined;
      }
      const spec = msg?.header?.get(SCHEDULE_HEADER);
      if (!spec) return undefined;
      // Only the `@at <rfc3339>` form is used for lineage deadlines.
      const at = spec.startsWith("@at ") ? Date.parse(spec.slice(4).trim()) : Number.NaN;
      return Number.isNaN(at) ? undefined : at;
    },
  };
}

/** Stream configuration the log and timer require. */
export function resonateStreamConfig(name: string, logPrefix: string, timerPrefix: string, tickPrefix: string) {
  return {
    name,
    subjects: [`${logPrefix}.>`, `${timerPrefix}.>`, `${tickPrefix}.>`],
    // Broker-side message schedules; the reason no scheduler process is needed.
    allow_msg_schedules: true,
    storage: "file",
  };
}
