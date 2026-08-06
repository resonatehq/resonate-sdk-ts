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
import { originFromScheduler, SCHEDULE_HEADER, SCHEDULER_HEADER } from "./nats-timer.js";

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

// =============================================================================
// TICK CONSUMPTION — closing the liveness loop
// =============================================================================
//
// A fired schedule lands in the stream and stays there. Something has to consume
// it and drive the machine's timeout transition, or the timer accomplishes
// nothing: the broker wakes up on time and the lineage still hangs.
//
// The consumer is durable and shared. Any library process may take any tick —
// `tick` is idempotent and version-guarded, so redundant delivery is harmless
// and no ownership or leader election is required. Because the consumer is
// durable, ticks that fire while every process is down are still delivered when
// one returns.

/** Drives lineage ticks fired by the broker. */
export interface TickSource {
  start(onTick: (origin: string) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface JsConsumerLike {
  consumers: {
    get(stream: string, durable: string): Promise<{ consume(): Promise<ConsumerMessages> }>;
  };
}

/**
 * The handle `consume()` returns. `stop()` matters: a source that only flips a
 * flag keeps its iterator attached to the shared durable and goes on taking
 * messages it will never process, so ticks vanish into a stopped consumer.
 */
export interface ConsumerMessages extends AsyncIterable<TickMsg> {
  stop?(): void;
  close?(): Promise<unknown>;
}

export interface TickMsg {
  subject: string;
  headers?: { get(k: string): string };
  ack(): void;
  nak(): void;
}

/**
 * A {@link TickSource} over a durable JetStream consumer on the tick subjects.
 *
 * The origin is recovered from the `Nats-Scheduler` header the server stamps on
 * a fired message, which names the schedule subject it came from.
 */
export function jetStreamTickSource(
  js: JsConsumerLike,
  jsm: JsmLike,
  stream: string,
  opts: { tickPrefix: string; timerPrefix: string; durable?: string },
): TickSource {
  const durable = opts.durable ?? "resonate-ticks";
  let stopped = false;
  let messages: ConsumerMessages | undefined;

  return {
    async start(onTick) {
      stopped = false;
      await jsm.consumers.add(stream, {
        durable_name: durable,
        filter_subject: `${opts.tickPrefix}.>`,
        ack_policy: "explicit",
        // Ticks are cheap and idempotent; a modest window keeps redelivery
        // bounded without serializing the whole stream.
        max_ack_pending: 32,
      });
      const consumer = await js.consumers.get(stream, durable);
      messages = await consumer.consume();

      void (async () => {
        for await (const msg of messages!) {
          if (stopped) return;
          try {
            const scheduler = msg.headers?.get(SCHEDULER_HEADER);
            const origin = scheduler ? originFromScheduler(scheduler, opts.timerPrefix) : undefined;
            if (origin === undefined) {
              // Not a message this source understands; drop it rather than
              // redeliver it forever.
              msg.ack();
              continue;
            }
            await onTick(origin);
            msg.ack();
          } catch {
            // Leave it unacked: the tick is still due, and redelivery retries.
            msg.nak();
          }
        }
      })();
    },

    async stop() {
      stopped = true;
      // Detach from the durable so no further messages are delivered here.
      // Without this the iterator keeps pulling and dropping ticks.
      try {
        messages?.stop?.();
        await messages?.close?.();
      } catch {
        /* already closed */
      }
      messages = undefined;
    },
  };
}
