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
export function resonateStreamConfig(
  name: string,
  logPrefix: string,
  timerPrefix: string,
  tickPrefix: string,
  msgPrefix?: string,
) {
  return {
    name,
    subjects: [
      `${logPrefix}.>`,
      `${timerPrefix}.>`,
      // A schedule's fire target must be a stream subject — nats-server rejects
      // anything else — so the tick subjects belong to the stream.
      `${tickPrefix}.>`,
      ...(msgPrefix ? [`${msgPrefix}.>`] : []),
    ],
    // Broker-side message schedules; the reason no scheduler process is needed.
    allow_msg_schedules: true,
    storage: "file",
  };
}

// =============================================================================
// ONE CONSUMER — worker messages and broker ticks together
// =============================================================================
//
// A broker-fired schedule must land in a stream: nats-server rejects a schedule
// whose target is not a stream subject ("message schedules target is invalid"),
// so it can never be delivered straight to a core subscription. Getting it out
// therefore requires a consumer — but not a *second* one.
//
// A process already needs a consumer to receive `execute` and `unblock`, so the
// tick rides on it. One durable consumer per process filters both the tick
// subjects and this process's message subjects, and dispatches on subject:
//
//   {tickPrefix}.>  -> runtime.tick(origin)      (server-side work)
//   {msgPrefix}.>   -> recv callbacks            (worker-side work)
//
// Both are server and worker in the same process, which is what makes a single
// channel correct here rather than merely convenient.
//
// The consumer is durable, so ticks that fire while every process is down are
// delivered once one returns; and shared, so any process may take any tick —
// `tick` is idempotent and version-guarded, needing no ownership or election.

/** Delivers everything a process consumes from NATS. */
export interface NatsMessageSource {
  start(handlers: { onTick: (origin: string) => Promise<void>; onMessage: (raw: Uint8Array) => void }): Promise<void>;
  stop(): Promise<void>;
}

export interface JsConsumerLike {
  consumers: {
    get(stream: string, durable: string): Promise<{ consume(): Promise<ConsumerMessages> }>;
  };
}

/**
 * The handle `consume()` returns. `stop()` matters: a source that only flips a
 * flag keeps its iterator attached to the durable and goes on taking messages
 * it will never process, so work vanishes into a stopped consumer.
 */
export interface ConsumerMessages extends AsyncIterable<InboundMsg> {
  stop?(): void;
  close?(): Promise<unknown>;
}

export interface InboundMsg {
  subject: string;
  data: Uint8Array;
  headers?: { get(k: string): string };
  ack(): void;
  nak(): void;
}

/**
 * A single durable JetStream consumer serving both roles.
 *
 * `durable` should be per worker-group, so group members share the queue and a
 * tick or an anycast message is taken by exactly one of them.
 */
export function jetStreamMessageSource(
  js: JsConsumerLike,
  jsm: JsmLike,
  stream: string,
  opts: { tickPrefix: string; timerPrefix: string; msgPrefix: string; durable: string },
): NatsMessageSource {
  let stopped = false;
  let messages: ConsumerMessages | undefined;

  return {
    async start({ onTick, onMessage }) {
      stopped = false;
      await jsm.consumers.add(stream, {
        durable_name: opts.durable,
        // One consumer, both concerns. `filter_subjects` (plural) needs
        // server 2.10+, which the 2.12 schedule floor already implies.
        filter_subjects: [`${opts.tickPrefix}.>`, `${opts.msgPrefix}.>`],
        ack_policy: "explicit",
        max_ack_pending: 64,
      });
      const consumer = await js.consumers.get(stream, opts.durable);
      messages = await consumer.consume();

      void (async () => {
        for await (const msg of messages!) {
          if (stopped) return;
          try {
            if (msg.subject.startsWith(`${opts.tickPrefix}.`)) {
              const scheduler = msg.headers?.get(SCHEDULER_HEADER);
              const origin = scheduler ? originFromScheduler(scheduler, opts.timerPrefix) : undefined;
              if (origin === undefined) {
                // Nothing this source can route; drop rather than redeliver forever.
                msg.ack();
                continue;
              }
              await onTick(origin);
            } else {
              onMessage(msg.data);
            }
            msg.ack();
          } catch {
            // Still due: leave it unacked so redelivery retries.
            msg.nak();
          }
        }
      })();
    },

    async stop() {
      stopped = true;
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
