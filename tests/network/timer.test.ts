import { describe, expect, test } from "@jest/globals";
import type { Change } from "../../src/network/local.js";
import { ConflictError, MemoryLog, type OriginLog } from "../../src/network/server/log.js";
import { CollectingTransport, OriginRuntime } from "../../src/network/server/runtime.js";
import { MemoryTimerService, RecordingTimerService } from "../../src/network/server/timer.js";
import type { Request } from "../../src/network/types.js";
import { VERSION } from "../../src/util.js";

// =============================================================================
// TIMER SAFETY
// =============================================================================
//
// Timers are the only mechanism that restarts a stalled lineage, so the
// property that matters is one-sided:
//
//     the armed deadline is never LATER than the committed state requires.
//
// Early is free — `tick` finds nothing due and commits nothing. Late, or
// missing, is a workflow that hangs forever. These tests check that the commit
// path maintains the one-sided invariant even when appends fail.

const head = () => ({ corrId: "c", version: VERSION });
const TARGET = "local://any@default";

function createReq(id: string, timeoutAt: number, tags: Record<string, string> = {}): Request {
  return { kind: "promise.create", head: head(), data: { id, timeoutAt, param: {}, tags } };
}

/** Fails every append, to model a crash between arming and committing. */
class BrokenLog implements OriginLog {
  constructor(private inner: OriginLog) {}
  async append(origin: string, _changes: Change[], expectedSeq: number): Promise<number> {
    throw new ConflictError(origin, expectedSeq, expectedSeq + 1);
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

describe("nextDue", () => {
  test("is the earliest deadline in the lineage", async () => {
    const log = new MemoryLog();
    const timers = new MemoryTimerService();
    const runtime = new OriginRuntime({ log, timers });
    const now = 1000;

    await runtime.apply(now, createReq("root", now + 50_000));
    await runtime.apply(now, createReq("root.a", now + 10_000));
    await runtime.apply(now, createReq("root.b", now + 90_000));

    expect((await runtime.inspect("root")).nextDue()).toBe(now + 10_000);
  });

  test("is undefined for a lineage with no pending work", async () => {
    const log = new MemoryLog();
    const runtime = new OriginRuntime({ log });
    const now = 1000;

    await runtime.apply(now, createReq("root", now + 10_000));
    await runtime.apply(now, {
      kind: "promise.settle",
      head: head(),
      data: { id: "root", state: "resolved", value: {} },
    });

    expect((await runtime.inspect("root")).nextDue()).toBeUndefined();
  });

  test("accounts for task timers, not just promise deadlines", async () => {
    const log = new MemoryLog();
    const runtime = new OriginRuntime({ log, transport: new CollectingTransport() });
    const now = 1000;

    // A promise with a target also creates a task with a retry timer, and the
    // retry TTL (30s) is sooner than the promise deadline.
    await runtime.apply(now, createReq("root", now + 500_000, { "resonate:target": TARGET }));

    const due = (await runtime.inspect("root")).nextDue();
    expect(due).toBeLessThan(now + 500_000);
  });
});

describe("arm-before-commit discipline", () => {
  test("a timer is armed before the append, not after", async () => {
    const timers = new RecordingTimerService();
    const runtime = new OriginRuntime({ log: new MemoryLog(), timers });
    const now = 1000;

    await runtime.apply(now, createReq("root", now + 10_000));

    // The pre-commit arm must come first; the post-commit authoritative set
    // follows it.
    expect(timers.calls.map((c) => c.op)).toEqual(["arm", "set"]);
    expect(timers.calls[0].at).toBe(now + 10_000);
  });

  test("a failed commit still leaves the lineage protected", async () => {
    // The crash this guards: arm after commit, die in between, and the
    // committed state has no timer and no path back.
    const timers = new MemoryTimerService();
    const runtime = new OriginRuntime({ log: new BrokenLog(new MemoryLog()), timers, maxAttempts: 1 });
    const now = 1000;

    await expect(runtime.apply(now, createReq("root", now + 10_000))).rejects.toThrow();

    // Nothing committed, but a timer is armed anyway — over-approximating. A
    // spurious fire costs one no-op tick; a missing one costs the lineage.
    expect(await timers.deadline("root")).toBe(now + 10_000);
  });

  test("a deadline is never relaxed before its commit lands", async () => {
    const timers = new RecordingTimerService();
    const log = new MemoryLog();
    const runtime = new OriginRuntime({ log, timers });
    const now = 1000;

    await runtime.apply(now, createReq("root.soon", now + 5_000));
    timers.calls.length = 0;

    // Settling the early promise pushes the lineage's deadline later. That
    // relaxation must only ever be issued through `set`, after the append.
    await runtime.apply(now, createReq("root.later", now + 90_000));
    await runtime.apply(now, {
      kind: "promise.settle",
      head: head(),
      data: { id: "root.soon", state: "resolved", value: {} },
    });

    // No `arm` call ever moves a deadline later — `armNoLaterThan` cannot, by
    // construction — so every relaxation is a post-commit `set`.
    for (const call of timers.calls.filter((c) => c.op === "arm")) {
      expect(call.at).toBeLessThanOrEqual(now + 90_000);
    }
    expect(timers.calls.some((c) => c.op === "set")).toBe(true);
  });

  test("materializing a lineage re-asserts its deadline", async () => {
    // The repair path: if a registration were ever lost, any request, tick or
    // recovery that materializes the origin puts it back — no scan required.
    const log = new MemoryLog();
    const now = 1000;

    const first = new OriginRuntime({ log, timers: new MemoryTimerService() });
    await first.apply(now, createReq("root", now + 10_000));

    // A new process with an empty timer service, as after a total restart.
    const timers = new MemoryTimerService();
    const second = new OriginRuntime({ log, timers });
    expect(await timers.deadline("root")).toBeUndefined();

    await second.inspect("root");
    expect(await timers.deadline("root")).toBe(now + 10_000);
  });
});

describe("MemoryTimerService", () => {
  test("armNoLaterThan only ever moves a deadline earlier", async () => {
    const timers = new MemoryTimerService();
    await timers.armNoLaterThan("o", 5_000);
    await timers.armNoLaterThan("o", 9_000);
    expect(await timers.deadline("o")).toBe(5_000);

    await timers.armNoLaterThan("o", 2_000);
    expect(await timers.deadline("o")).toBe(2_000);
  });

  test("setDeadline is authoritative and may move later or clear", async () => {
    const timers = new MemoryTimerService();
    await timers.armNoLaterThan("o", 5_000);

    await timers.setDeadline("o", 9_000);
    expect(await timers.deadline("o")).toBe(9_000);

    await timers.setDeadline("o", undefined);
    expect(await timers.deadline("o")).toBeUndefined();
  });

  test("fires at the deadline", async () => {
    const fired: string[] = [];
    const timers = new MemoryTimerService((origin) => fired.push(origin));
    await timers.armNoLaterThan("o", Date.now() + 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toEqual(["o"]);
    timers.stop();
  });
});

describe("no timer is ever late", () => {
  // The one-sided invariant, checked across a randomized sequence of commits
  // and failed commits: after every operation the armed deadline is at or
  // before whatever the durable state requires.
  test("armed deadline never trails committed state", async () => {
    for (let seed = 0; seed < 50; seed++) {
      const log = new MemoryLog();
      const flaky = new BrokenLog(log);
      const timers = new MemoryTimerService();
      let state = 0xc0ffee ^ seed;
      const rand = () => (state = (1664525 * state + 1013904223) >>> 0) / 0x100000000;

      const now = 1000;
      let n = 0;

      for (let step = 0; step < 25; step++) {
        // Some commits are made against a log that always fails, modelling a
        // crash after arming.
        const broken = rand() < 0.3;
        const runtime = new OriginRuntime({
          log: broken ? flaky : log,
          timers,
          maxAttempts: 1,
          transport: new CollectingTransport(),
        });

        n += 1;
        const deadline = now + Math.floor(rand() * 100_000) + 1_000;
        try {
          await runtime.apply(now, createReq(`root.p${n}`, deadline));
        } catch {
          // Expected for the broken log.
        }

        // Read committed state through a runtime with no timer service, so
        // inspecting cannot itself repair the deadline being checked.
        const committed = await new OriginRuntime({ log }).inspect("root");
        const required = committed.nextDue();
        const armed = await timers.deadline("root");

        if (required !== undefined) {
          expect(armed).toBeDefined();
          expect(armed!).toBeLessThanOrEqual(required);
        }
      }
    }
  });
});
