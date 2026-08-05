// =============================================================================
// JetStream-backed OriginLog
// =============================================================================
//
// Maps the {@link OriginLog} contract onto a JetStream stream, one subject per
// origin. The conditional append is JetStream's own optimistic concurrency
// control: publishing with `expect.lastSubjectSequence` succeeds only if the
// caller's view of the subject's head is current, which is exactly the CAS the
// runtime needs and costs a sequence comparison rather than a whole-blob
// rewrite.
//
// Sequence numbers are the stream sequences of the messages themselves, so they
// are monotonic but not contiguous — which the `OriginLog` contract permits.
// `expect.lastSubjectSequence: 0` asserts the subject is empty, giving
// create-if-absent for a lineage's first commit.
//
// Everything here is written against {@link JsBinding}, a deliberately small
// interface, so the mapping is exercised by tests with a fake binding. Only
// `natsBinding` touches the real client, and it is the sole part of this file
// that a live-server integration test is required to validate.

import type { Change } from "../local.js";
import { ConflictError, type LogEntry, type OriginLog } from "./log.js";

/** Subject prefix for origin logs. Distinct from the request subjects in `nats.ts`. */
export const DEFAULT_LOG_PREFIX = "resonate.log";

/**
 * The minimal JetStream surface an origin log needs.
 *
 * Kept narrow on purpose: it is the seam between logic that can be tested
 * without a broker and the client binding that cannot.
 */
export interface JsBinding {
  /**
   * Publish to `subject`, asserting `expectLastSubjectSeq` is the subject's
   * current head (0 meaning empty). Returns the new stream sequence.
   * Must throw {@link ConflictError} when the assertion fails.
   */
  publish(subject: string, payload: Uint8Array, expectLastSubjectSeq: number): Promise<number>;
  /** Messages on `subject` with stream sequence greater than `fromSeq`, in order. */
  fetch(subject: string, fromSeq: number): Promise<{ seq: number; payload: Uint8Array }[]>;
  /** The subject's head sequence, or 0 when it holds no messages. */
  lastSeq(subject: string): Promise<number>;
  /** Delete messages on `subject` at or below `throughSeq`. */
  purgeUpTo(subject: string, throughSeq: number): Promise<void>;
  /** Subjects with at least one message under `prefix`. */
  subjects(prefix: string): Promise<string[]>;
}

// Origins may contain `.`, `/` and unicode; base64url yields a single valid
// subject token. This is the same encoding `resonate-on-nats` uses for its
// request subjects (`stream.go: PublishSubject`), so origins map identically on
// both sides.
function encodeOrigin(origin: string): string {
  return Buffer.from(origin, "utf8").toString("base64url");
}

function decodeOrigin(token: string): string {
  return Buffer.from(token, "base64url").toString("utf8");
}

export class JetStreamLog implements OriginLog {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly js: JsBinding,
    private readonly prefix: string = DEFAULT_LOG_PREFIX,
  ) {}

  private subject(origin: string): string {
    return `${this.prefix}.${encodeOrigin(origin)}`;
  }

  async append(origin: string, changes: Change[], expectedSeq: number): Promise<number> {
    // The whole batch is one message: that is what makes a commit atomic. A
    // per-change message would allow a torn commit, reintroducing the very
    // window this design exists to close.
    const payload = this.encoder.encode(JSON.stringify(changes));
    return this.js.publish(this.subject(origin), payload, expectedSeq);
  }

  async read(origin: string, fromSeq: number): Promise<LogEntry[]> {
    const msgs = await this.js.fetch(this.subject(origin), fromSeq);
    return msgs.map((m) => ({ seq: m.seq, changes: JSON.parse(this.decoder.decode(m.payload)) as Change[] }));
  }

  async head(origin: string): Promise<number> {
    return this.js.lastSeq(this.subject(origin));
  }

  async trim(origin: string, throughSeq: number): Promise<void> {
    await this.js.purgeUpTo(this.subject(origin), throughSeq);
  }

  async origins(): Promise<string[]> {
    const subjects = await this.js.subjects(this.prefix);
    return subjects.map((s) => decodeOrigin(s.slice(this.prefix.length + 1)));
  }
}

// =============================================================================
// REAL CLIENT BINDING
// =============================================================================

/**
 * Shape of the `@nats-io/jetstream` client this binding uses. Declared
 * structurally so the SDK carries no hard dependency on the optional package.
 */
export interface NatsJetStreamLike {
  publish(
    subject: string,
    payload: Uint8Array,
    opts?: { expect?: { lastSubjectSequence?: number } },
  ): Promise<{ seq: number }>;
}

/**
 * Adapt a live `@nats-io/jetstream` client to {@link JsBinding}.
 *
 * NOTE: unlike the rest of this module, this function is not covered by the
 * test suite — it needs a running NATS server. `tests/network/jetstream.test.ts`
 * exercises `JetStreamLog` against a fake binding that models the same
 * contract; validating *this* mapping requires the integration test described
 * in the module docs.
 *
 * The stream must be created with `allow_msg_schedules` left off (this log does
 * not use scheduled messages) and a retention policy that permits per-subject
 * purge, since `trim` reclaims history behind a snapshot.
 */
export function natsBinding(js: NatsJetStreamLike, helpers: Omit<JsBinding, "publish">): JsBinding {
  return {
    async publish(subject, payload, expectLastSubjectSeq) {
      try {
        const ack = await js.publish(subject, payload, {
          expect: { lastSubjectSequence: expectLastSubjectSeq },
        });
        return ack.seq;
      } catch (err) {
        // The server rejects a failed expectation with a "wrong last sequence"
        // API error; surface it as the runtime's retryable conflict.
        const message = err instanceof Error ? err.message : String(err);
        if (/wrong last sequence/i.test(message)) {
          throw new ConflictError(subject, expectLastSubjectSeq, -1);
        }
        throw err;
      }
    },
    fetch: helpers.fetch,
    lastSeq: helpers.lastSeq,
    purgeUpTo: helpers.purgeUpTo,
    subjects: helpers.subjects,
  };
}
