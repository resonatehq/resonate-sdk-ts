import { describe, expect, test } from "@jest/globals";
import type { Change } from "../../src/network/local.js";
import { ConflictError, MemoryLog, MemorySnapshotStore, type OriginLog } from "../../src/network/server/log.js";
import {
  CollectingTransport,
  OriginRuntime,
  originOf,
  routingOrigin,
  TooManyConflictsError,
  type Transport,
} from "../../src/network/server/runtime.js";
import { snapshot } from "../../src/network/server/state.js";
import { isSuccess, type Message, type Request } from "../../src/network/types.js";
import { VERSION } from "../../src/util.js";

const TARGET = "local://any@default";
const head = () => ({ corrId: "c", version: VERSION });

function createReq(id: string, now: number, tags: Record<string, string> = {}): Request {
  return {
    kind: "promise.create",
    head: head(),
    data: { id, timeoutAt: now + 60_000, param: {}, tags },
  };
}

/** A transport that fails the first `n` publishes, to exercise the flush cursor. */
class FlakyTransport implements Transport {
  readonly sent: { address: string; message: Message }[] = [];
  constructor(private failures: number) {}
  async publish(address: string, message: Message): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("transport down");
    }
    this.sent.push({ address, message });
  }
}

/** Wraps a log so a scripted number of appends are rejected as conflicts. */
class ConflictInjectingLog implements OriginLog {
  constructor(
    private inner: OriginLog,
    private failures: number,
  ) {}
  async append(origin: string, changes: Change[], expectedSeq: number): Promise<number> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new ConflictError(origin, expectedSeq, expectedSeq + 1);
    }
    return this.inner.append(origin, changes, expectedSeq);
  }
  read(origin: string, fromSeq: number) {
    return this.inner.read(origin, fromSeq);
  }
  head(origin: string) {
    return this.inner.head(origin);
  }
  trim(origin: string, throughSeq: number) {
    return this.inner.trim(origin, throughSeq);
  }
  origins() {
    return this.inner.origins();
  }
}

describe("origin routing", () => {
  test("derives the lineage root", () => {
    expect(originOf("root")).toBe("root");
    expect(originOf("root.child")).toBe("root");
    expect(originOf("root.child.grandchild")).toBe("root");
  });

  test("routes each request kind to the lineage it touches", () => {
    const now = 1000;
    expect(routingOrigin(createReq("root.a", now))).toBe("root");
    expect(
      routingOrigin({ kind: "promise.register_callback", head: head(), data: { awaited: "r.a", awaiter: "x.b" } }),
    ).toBe("r");
    expect(
      routingOrigin({ kind: "task.heartbeat", head: head(), data: { pid: "p", tasks: [{ id: "r.a", version: 1 }] } }),
    ).toBe("r");
    // Requests that touch no lineage share a partition.
    expect(routingOrigin({ kind: "promise.search", head: head(), data: {} })).toBe("default");
  });
});

describe("commit", () => {
  test("a request's effects are durable in the log", async () => {
    const log = new MemoryLog();
    const runtime = new OriginRuntime({ log });
    const now = 1000;

    const res = await runtime.apply(now, createReq("root", now));
    expect(isSuccess(res)).toBe(true);
    expect(await log.head("root")).toBe(1);

    const entries = await log.read("root", 0);
    expect(entries[0].changes.some((c) => c.kind === "promise.set")).toBe(true);
  });

  test("state survives eviction, rebuilt from the log", async () => {
    const log = new MemoryLog();
    const runtime = new OriginRuntime({ log });
    const now = 1000;

    await runtime.apply(now, createReq("root", now));
    await runtime.apply(now, createReq("root.child", now));

    const before = snapshot(await runtime.inspect("root"));
    // Simulate losing the process heap.
    runtime.evict();
    const after = snapshot(await runtime.inspect("root"));

    expect(after).toEqual(before);
    expect(Object.keys(after.promises).sort()).toEqual(["root", "root.child"]);
  });

  test("reads are served from durable state after a cold start", async () => {
    const log = new MemoryLog();
    const now = 1000;

    const first = new OriginRuntime({ log });
    await first.apply(now, createReq("root", now));

    // A different runtime instance, sharing only the log.
    const second = new OriginRuntime({ log });
    const res = await second.apply(now, { kind: "promise.get", head: head(), data: { id: "root" } });
    expect(isSuccess(res)).toBe(true);
    if (res.kind === "promise.get" && isSuccess(res)) {
      expect(res.data.promise.id).toBe("root");
    }
  });
});

describe("concurrency", () => {
  test("same-origin requests are serialized within a process", async () => {
    const log = new MemoryLog();
    const runtime = new OriginRuntime({ log });
    const now = 1000;

    // Fire a fan-out concurrently: every child shares the "root" lineage, so
    // without in-process serialization these would all contend on CAS.
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => runtime.apply(now, createReq(`root.c${i}`, now))),
    );

    expect(results.every(isSuccess)).toBe(true);
    // 25 sequential commits, no conflict retries, no lost updates.
    expect(await log.head("root")).toBe(25);
    const state = snapshot(await runtime.inspect("root"));
    expect(Object.keys(state.promises)).toHaveLength(25);
  });

  test("a conflicting append is retried against re-materialized state", async () => {
    const inner = new MemoryLog();
    const log = new ConflictInjectingLog(inner, 2);
    const runtime = new OriginRuntime({ log });
    const now = 1000;

    const res = await runtime.apply(now, createReq("root", now));
    expect(isSuccess(res)).toBe(true);
    // Two rejections, third attempt committed exactly one entry.
    expect(await inner.head("root")).toBe(1);
  });

  test("a request is abandoned after the attempt limit", async () => {
    const log = new ConflictInjectingLog(new MemoryLog(), 99);
    const runtime = new OriginRuntime({ log, maxAttempts: 3 });
    await expect(runtime.apply(1000, createReq("root", 1000))).rejects.toThrow(TooManyConflictsError);
  });

  test("two runtimes sharing a log do not lose updates", async () => {
    const log = new MemoryLog();
    const a = new OriginRuntime({ log });
    const b = new OriginRuntime({ log });
    const now = 1000;

    // Interleave writers against the same lineage. Each has its own cache, so
    // they genuinely race on the conditional append.
    for (let i = 0; i < 10; i++) {
      await a.apply(now, createReq(`root.a${i}`, now));
      await b.apply(now, createReq(`root.b${i}`, now));
    }

    // Every write is durable: 20 commits, none silently overwritten.
    expect(await log.head("root")).toBe(20);
    a.evict();
    expect(Object.keys(snapshot(await a.inspect("root")).promises)).toHaveLength(20);
  });

  test("a cached view lags at most the peer writes since its own last commit", async () => {
    const log = new MemoryLog();
    const a = new OriginRuntime({ log });
    const b = new OriginRuntime({ log });
    const now = 1000;

    for (let i = 0; i < 5; i++) {
      await a.apply(now, createReq(`root.a${i}`, now));
      await b.apply(now, createReq(`root.b${i}`, now));
    }

    // `a` has not acted since b's last commit, so it has yet to observe it. A
    // stale cache is always a strict prefix of durable state, never divergent.
    const stale = Object.keys(snapshot(await a.inspect("root")).promises);
    expect(stale).toHaveLength(9);
    expect(stale).not.toContain("root.b4");

    // One more commit forces the conflict that re-materializes, and `a`
    // converges without any explicit invalidation.
    await a.apply(now, createReq("root.a5", now));
    const fresh = Object.keys(snapshot(await a.inspect("root")).promises);
    expect(fresh).toHaveLength(11);
    expect(fresh).toContain("root.b4");
  });
});

describe("message delivery", () => {
  test("messages committed to the log are published", async () => {
    const log = new MemoryLog();
    const transport = new CollectingTransport();
    const runtime = new OriginRuntime({ log, transport });
    const now = 1000;

    await runtime.apply(now, createReq("root", now, { "resonate:target": TARGET }));

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].address).toBe(TARGET);
    expect(transport.sent[0].message.kind).toBe("execute");
  });

  test("materialized state does not accumulate an outbox", async () => {
    const log = new MemoryLog();
    const runtime = new OriginRuntime({ log, transport: new CollectingTransport() });
    const now = 1000;

    for (let i = 0; i < 5; i++) {
      await runtime.apply(now, createReq(`root.c${i}`, now, { "resonate:target": TARGET }));
    }

    // The log holds the messages; materialized state must not also retain them.
    expect(snapshot(await runtime.inspect("root")).outbox).toEqual([]);
  });

  test("messages committed but not published are re-sent by recovery", async () => {
    const log = new MemoryLog();
    // Every publish fails, so the flush cursor never advances.
    const failing = new FlakyTransport(99);
    const runtime = new OriginRuntime({ log, transport: failing });
    const now = 1000;

    await expect(runtime.apply(now, createReq("root", now, { "resonate:target": TARGET }))).rejects.toThrow(
      "transport down",
    );

    // The commit is durable even though delivery failed — this is the case that
    // silently strands a lineage when effects are published outside the commit.
    expect(await log.head("root")).toBe(1);

    // A healthy process takes over and recovers the origin.
    const healthy = new CollectingTransport();
    const recovered = new OriginRuntime({ log, transport: healthy });
    const sent = await recovered.recover("root");

    expect(sent).toBe(1);
    expect(healthy.sent[0].message.kind).toBe("execute");
  });

  test("recovery is idempotent once messages are flushed", async () => {
    const log = new MemoryLog();
    const transport = new CollectingTransport();
    const runtime = new OriginRuntime({ log, transport });
    const now = 1000;

    await runtime.apply(now, createReq("root", now, { "resonate:target": TARGET }));
    expect(transport.sent).toHaveLength(1);

    // Already flushed by this runtime: nothing more to send.
    expect(await runtime.recover("root")).toBe(0);
    expect(transport.sent).toHaveLength(1);
  });
});

describe("snapshots", () => {
  test("a checkpoint is taken and the log is trimmed behind it", async () => {
    const log = new MemoryLog();
    const snapshots = new MemorySnapshotStore();
    const runtime = new OriginRuntime({ log, snapshots, transport: new CollectingTransport(), snapshotEvery: 5 });
    const now = 1000;

    for (let i = 0; i < 12; i++) {
      await runtime.apply(now, createReq(`root.c${i}`, now));
    }

    const checkpoint = await snapshots.load("root");
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.seq).toBeGreaterThanOrEqual(10);
    // History before the checkpoint is reclaimed rather than growing forever.
    expect(log.size()).toBeLessThan(12);
  });

  test("recovery from a checkpoint plus tail reproduces full state", async () => {
    const log = new MemoryLog();
    const snapshots = new MemorySnapshotStore();
    const runtime = new OriginRuntime({ log, snapshots, transport: new CollectingTransport(), snapshotEvery: 4 });
    const now = 1000;

    for (let i = 0; i < 14; i++) {
      await runtime.apply(now, createReq(`root.c${i}`, now));
    }
    const before = snapshot(await runtime.inspect("root"));

    // Cold start against the same durable state: snapshot + surviving tail.
    const cold = new OriginRuntime({ log, snapshots });
    expect(snapshot(await cold.inspect("root"))).toEqual(before);
    expect(Object.keys(before.promises)).toHaveLength(14);
  });
});

describe("lineage lifecycle", () => {
  test("a full acquire/suspend/settle/resume cycle survives repeated cold starts", async () => {
    const log = new MemoryLog();
    const snapshots = new MemorySnapshotStore();
    const transport = new CollectingTransport();
    const now = 1000;

    // A fresh runtime per step: every request is served by a process that has
    // just rebuilt the lineage from durable state.
    const step = async (req: Request) => {
      const rt = new OriginRuntime({ log, snapshots, transport });
      return rt.apply(now, req);
    };

    await step(createReq("root", now, { "resonate:target": TARGET, "resonate:branch": "root" }));
    await step({ kind: "task.acquire", head: head(), data: { id: "root", version: 0, pid: "pid", ttl: 30_000 } });
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

    const suspended = snapshot(await new OriginRuntime({ log, snapshots }).inspect("root"));
    expect(suspended.tasks.root.state).toBe("suspended");
    // The awaiter edge survived the log round-trip — this is what the lossy
    // change log used to drop.
    expect(suspended.callbacks["root.child"]).toEqual(["root"]);

    await step({
      kind: "promise.settle",
      head: head(),
      data: { id: "root.child", state: "resolved", value: { data: "v" } },
    });

    const resumed = snapshot(await new OriginRuntime({ log, snapshots }).inspect("root"));
    expect(resumed.tasks.root.state).toBe("pending");
    // Settling the awaited promise re-dispatched the suspended task.
    expect(transport.sent.filter((m) => m.message.kind === "execute").length).toBeGreaterThanOrEqual(2);
  });
});
