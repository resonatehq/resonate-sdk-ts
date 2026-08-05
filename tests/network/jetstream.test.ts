import { describe, expect, test } from "@jest/globals";
import type { Change } from "../../src/network/local.js";
import { JetStreamLog, type JsBinding } from "../../src/network/server/jetstream.js";
import { ConflictError, MemorySnapshotStore } from "../../src/network/server/log.js";
import { CollectingTransport, OriginRuntime } from "../../src/network/server/runtime.js";
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
    // Models `purge({ filter: subject, keep: 1 })`: the newest message on the
    // subject always survives, so the subject never disappears.
    const newest = this.heads.get(subject) ?? 0;
    this.messages = this.messages.filter((m) => !(m.subject === subject && m.seq <= throughSeq && m.seq !== newest));
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
    // One message is retained on purpose; see JsBinding.purgeUpTo.
    expect(js.count()).toBe(1);
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

describe("timer discoverability", () => {
  test("an origin stays discoverable after its log is trimmed", async () => {
    const js = new FakeJetStream();
    const log = new JetStreamLog(js);

    let seq = 0;
    for (let i = 0; i < 3; i++) seq = await log.append("root", change(`p${i}`), seq);
    expect(await log.origins()).toEqual(["root"]);

    // A snapshot lets the runtime reclaim history. The origin must remain
    // visible afterwards: the sweeper finds work by enumerating origins, so an
    // invisible origin is a lineage whose timers can never fire again.
    await log.trim("root", seq);
    expect(await log.origins()).toEqual(["root"]);
  });
});

describe("timer liveness across total shutdown", () => {
  // Timers are the only thing that restarts a stalled lineage: every recovery
  // path in the protocol — a lost execute, a dead worker's lease, an unsettled
  // promise, a due schedule — bottoms out in one. So the property that matters
  // is that a timer survives *everything*: snapshotting, trimming, and every
  // process going away.
  test("a due timeout still fires after snapshot, trim and total process loss", async () => {
    const js = new FakeJetStream();
    const log = new JetStreamLog(js);
    const snapshots = new MemorySnapshotStore();
    const transport = new CollectingTransport();
    const start = 1_000_000;

    // Phase 1: a lineage with a deadline, plus enough traffic to force a
    // snapshot and trim of its log.
    const first = new OriginRuntime({ log, snapshots, transport, snapshotEvery: 3 });
    await first.apply(start, {
      kind: "promise.create",
      head: head(),
      data: { id: "root", timeoutAt: start + 10_000, param: {}, tags: {} },
    });
    for (let i = 0; i < 8; i++) {
      await first.apply(start, createReq(`root.c${i}`, start));
    }
    const snapshotTaken = await snapshots.load("root");
    expect(snapshotTaken).toBeDefined();

    // Phase 2: every process is gone. Nothing is cached anywhere; the only
    // surviving state is the trimmed log plus the snapshot.
    const revived = new OriginRuntime({ log, snapshots, transport: new CollectingTransport() });

    // The origin must still be enumerable, or the sweeper will never look at it.
    expect(await log.origins()).toContain("root");

    // Phase 3: time has passed while nothing was running. The sweep must catch
    // up and settle the promise that expired in the meantime.
    const fired = await revived.sweep(start + 60_000);
    expect(fired).toBeGreaterThan(0);

    const state = snapshot(await revived.inspect("root"));
    expect(state.promises.root.state).toBe("rejected_timedout");
  });

  test("a lineage whose log is fully trimmed is still swept", async () => {
    const js = new FakeJetStream();
    const log = new JetStreamLog(js);
    const snapshots = new MemorySnapshotStore();
    const start = 1_000_000;

    const rt = new OriginRuntime({ log, snapshots, transport: new CollectingTransport(), snapshotEvery: 1 });
    await rt.apply(start, {
      kind: "promise.create",
      head: head(),
      data: { id: "solo", timeoutAt: start + 5_000, param: {}, tags: {} },
    });

    // Aggressive trimming must not make the origin invisible.
    expect(await log.origins()).toContain("solo");
    expect(await new OriginRuntime({ log, snapshots }).sweep(start + 60_000)).toBeGreaterThan(0);
  });
});
