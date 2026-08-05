import { describe, expect, test } from "@jest/globals";
import type { Change } from "../../src/network/local.js";
import { JetStreamLog, type JsBinding } from "../../src/network/server/jetstream.js";
import { ConflictError } from "../../src/network/server/log.js";
import { OriginRuntime } from "../../src/network/server/runtime.js";
import { snapshot } from "../../src/network/server/state.js";
import { isSuccess, type Request } from "../../src/network/types.js";
import { VERSION } from "../../src/util.js";

// =============================================================================
// FAKE JETSTREAM BINDING
// =============================================================================
//
// Models the JetStream semantics `JetStreamLog` relies on:
//   - one monotonically increasing sequence space shared across all subjects
//     (so per-subject sequences are monotonic but NOT contiguous, which is the
//     property the OriginLog contract has to tolerate),
//   - `expect.lastSubjectSequence` rejecting a publish whose view of the
//     subject head is stale, with 0 meaning "subject is empty",
//   - per-subject purge up to a sequence.
//
// Verified against `@nats-io/jetstream` 3.4.0's declared types; the live-server
// behaviour of the real binding is not covered here.

class FakeJetStream implements JsBinding {
  private streamSeq = 0;
  private messages: { subject: string; seq: number; payload: Uint8Array }[] = [];
  /** Head sequence per subject, retained across purges so cursors stay valid. */
  private heads = new Map<string, number>();

  async publish(subject: string, payload: Uint8Array, expectLastSubjectSeq: number): Promise<number> {
    const head = this.heads.get(subject) ?? 0;
    if (head !== expectLastSubjectSeq) {
      throw new ConflictError(subject, expectLastSubjectSeq, head);
    }
    this.streamSeq += 1;
    this.messages.push({ subject, seq: this.streamSeq, payload });
    this.heads.set(subject, this.streamSeq);
    return this.streamSeq;
  }

  async fetch(subject: string, fromSeq: number): Promise<{ seq: number; payload: Uint8Array }[]> {
    return this.messages
      .filter((m) => m.subject === subject && m.seq > fromSeq)
      .map((m) => ({ seq: m.seq, payload: m.payload }));
  }

  async lastSeq(subject: string): Promise<number> {
    return this.heads.get(subject) ?? 0;
  }

  async purgeUpTo(subject: string, throughSeq: number): Promise<void> {
    this.messages = this.messages.filter((m) => !(m.subject === subject && m.seq <= throughSeq));
  }

  async subjects(prefix: string): Promise<string[]> {
    return [...new Set(this.messages.filter((m) => m.subject.startsWith(`${prefix}.`)).map((m) => m.subject))];
  }

  /** Test helper: retained message count. */
  count(): number {
    return this.messages.length;
  }
}

const head = () => ({ corrId: "c", version: VERSION });
const change = (id: string): Change[] => [
  {
    kind: "promise.set",
    promise: {
      id,
      state: "pending",
      param: {},
      value: {},
      tags: {},
      timeoutAt: 0,
      createdAt: 0,
    },
    callbacks: [],
    listeners: [],
  },
];

function createReq(id: string, now: number, tags: Record<string, string> = {}): Request {
  return { kind: "promise.create", head: head(), data: { id, timeoutAt: now + 60_000, param: {}, tags } };
}

describe("JetStreamLog", () => {
  test("appends and reads back a batch", async () => {
    const log = new JetStreamLog(new FakeJetStream());
    const seq = await log.append("root", change("root.a"), 0);

    expect(seq).toBeGreaterThan(0);
    const entries = await log.read("root", 0);
    expect(entries).toHaveLength(1);
    expect(entries[0].changes).toEqual(change("root.a"));
  });

  test("a whole batch is one entry, so a commit cannot tear", async () => {
    const log = new JetStreamLog(new FakeJetStream());
    const batch = [...change("a"), ...change("b"), ...change("c")];
    await log.append("root", batch, 0);

    const entries = await log.read("root", 0);
    expect(entries).toHaveLength(1);
    expect(entries[0].changes).toHaveLength(3);
  });

  test("a stale expected sequence is rejected as a conflict", async () => {
    const log = new JetStreamLog(new FakeJetStream());
    const seq = await log.append("root", change("a"), 0);

    await expect(log.append("root", change("b"), 0)).rejects.toThrow(ConflictError);
    // Committing against the current head succeeds.
    await expect(log.append("root", change("b"), seq)).resolves.toBeGreaterThan(seq);
  });

  test("origins are isolated and round-trip through subject encoding", async () => {
    const log = new JetStreamLog(new FakeJetStream());
    // Origins containing characters that are not valid subject tokens.
    for (const origin of ["plain", "with.dots", "with/slash", "unicode-éè"]) {
      await log.append(origin, change(`${origin}-a`), 0);
    }
    expect((await log.origins()).sort()).toEqual(["plain", "unicode-éè", "with.dots", "with/slash"].sort());
    expect(await log.read("with.dots", 0)).toHaveLength(1);
  });

  test("sequences are monotonic but not contiguous across origins", async () => {
    const js = new FakeJetStream();
    const log = new JetStreamLog(js);

    const a1 = await log.append("a", change("a1"), 0);
    await log.append("b", change("b1"), 0);
    const a2 = await log.append("a", change("a2"), a1);

    // Interleaving with another origin skips sequence numbers on this subject.
    expect(a2).toBeGreaterThan(a1 + 1);
    expect(await log.head("a")).toBe(a2);
  });

  test("trim reclaims history without invalidating the head cursor", async () => {
    const js = new FakeJetStream();
    const log = new JetStreamLog(js);

    let seq = 0;
    for (let i = 0; i < 5; i++) seq = await log.append("root", change(`p${i}`), seq);
    expect(js.count()).toBe(5);

    await log.trim("root", seq);
    expect(js.count()).toBe(0);
    // The head is unchanged, so the next append still has to present it.
    expect(await log.head("root")).toBe(seq);
    await expect(log.append("root", change("after"), 0)).rejects.toThrow(ConflictError);
    await expect(log.append("root", change("after"), seq)).resolves.toBeGreaterThan(seq);
  });
});

describe("runtime over JetStreamLog", () => {
  test("commits, recovers and serves reads", async () => {
    const log = new JetStreamLog(new FakeJetStream());
    const runtime = new OriginRuntime({ log });
    const now = 1000;

    await runtime.apply(now, createReq("root", now));
    await runtime.apply(now, createReq("root.child", now));

    const before = snapshot(await runtime.inspect("root"));
    runtime.evict();
    expect(snapshot(await runtime.inspect("root"))).toEqual(before);
    expect(Object.keys(before.promises).sort()).toEqual(["root", "root.child"]);
  });

  test("two runtimes over one JetStream log do not lose updates", async () => {
    const log = new JetStreamLog(new FakeJetStream());
    const a = new OriginRuntime({ log });
    const b = new OriginRuntime({ log });
    const now = 1000;

    for (let i = 0; i < 10; i++) {
      await a.apply(now, createReq(`root.a${i}`, now));
      await b.apply(now, createReq(`root.b${i}`, now));
    }

    a.evict();
    expect(Object.keys(snapshot(await a.inspect("root")).promises)).toHaveLength(20);
  });

  test("a workflow lineage survives repeated cold starts", async () => {
    const log = new JetStreamLog(new FakeJetStream());
    const now = 1000;
    const step = (req: Request) => new OriginRuntime({ log }).apply(now, req);

    const created = await step(
      createReq("root", now, { "resonate:target": "local://any@default", "resonate:branch": "root" }),
    );
    expect(isSuccess(created)).toBe(true);

    await step({ kind: "task.acquire", head: head(), data: { id: "root", version: 0, pid: "p", ttl: 30_000 } });
    await step(createReq("root.child", now));
    await step({
      kind: "task.suspend",
      head: head(),
      data: {
        id: "root",
        version: 1,
        actions: [
          { kind: "promise.register_callback", head: head(), data: { awaited: "root.child", awaiter: "root" } },
        ],
      },
    });

    const state = snapshot(await new OriginRuntime({ log }).inspect("root"));
    expect(state.tasks.root.state).toBe("suspended");
    expect(state.callbacks["root.child"]).toEqual(["root"]);
  });
});
