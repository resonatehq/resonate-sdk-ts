import { afterEach, describe, expect, test } from "@jest/globals";
import type { Context } from "../../src/context.js";
import { DurableNetwork } from "../../src/network/durable.js";
import { MemoryLog, MemorySnapshotStore } from "../../src/network/server/log.js";
import { isSuccess } from "../../src/network/types.js";
import { Resonate } from "../../src/resonate.js";

// =============================================================================
// END-TO-END: the SDK driving its own server
// =============================================================================
//
// These run genuine generator-engine workflows through `Resonate` against a
// `DurableNetwork`, so the machine, the commit path, the timeout sweeper and
// the message transport are all exercised together — and, crucially, across
// simulated process death, which is the scenario the design exists for.

const networks: DurableNetwork[] = [];
function makeNetwork(...args: ConstructorParameters<typeof DurableNetwork>): DurableNetwork {
  const network = new DurableNetwork(...args);
  networks.push(network);
  return network;
}

afterEach(async () => {
  // Sweep timers keep the event loop alive; always tear them down.
  await Promise.all(networks.splice(0).map((n) => n.stop()));
});

describe("workflows over a durable network", () => {
  test("runs a workflow to completion", async () => {
    const resonate = new Resonate({ network: makeNetwork({ sweepInterval: 50 }) });

    const greet = resonate.register("greet", function* (_ctx, name: string) {
      return `hello ${name}`;
    });

    await expect(greet.run("greet-1", "world")).resolves.toBe("hello world");
    await resonate.stop();
  });

  test("runs a workflow that spawns children", async () => {
    const resonate = new Resonate({ network: makeNetwork({ sweepInterval: 50 }) });

    const double = (_ctx: Context, n: number) => n * 2;
    const sum = resonate.register("sum", function* (ctx: Context, n: number) {
      let total = 0;
      for (let i = 1; i <= n; i++) {
        total += yield* ctx.run(double, i);
      }
      return total;
    });

    // 2 + 4 + 6 + 8 = 20
    await expect(sum.run("sum-1", 4)).resolves.toBe(20);
    await resonate.stop();
  });

  test("a rejected workflow surfaces its error", async () => {
    const resonate = new Resonate({ network: makeNetwork({ sweepInterval: 50 }) });
    const boom = resonate.register("boom", function* () {
      throw new Error("kaboom");
    });

    await expect(boom.run("boom-1")).rejects.toThrow("kaboom");
    await resonate.stop();
  });

  test("state written by one process is visible to the next", async () => {
    // One log, two successive processes — the second must see what the first
    // durably committed.
    const log = new MemoryLog();
    const snapshots = new MemorySnapshotStore();

    const first = new Resonate({ network: makeNetwork({ log, snapshots, sweepInterval: 50 }) });
    const greet = first.register("greet", function* (_ctx, name: string) {
      return `hello ${name}`;
    });
    await expect(greet.run("shared-1", "world")).resolves.toBe("hello world");
    await first.stop();

    // A fresh process against the same durable state.
    const second = new Resonate({ network: makeNetwork({ log, snapshots, sweepInterval: 50 }) });
    const promise = await second.promises.get("shared-1");
    expect(promise.state).toBe("resolved");
    await second.stop();
  });

  test("a completed workflow is not re-executed after recovery", async () => {
    const log = new MemoryLog();
    let executions = 0;

    const first = new Resonate({ network: makeNetwork({ log, sweepInterval: 50 }) });
    const counted = first.register("counted", function* () {
      executions += 1;
      return "done";
    });
    await expect(counted.run("dedup-1")).resolves.toBe("done");
    await first.stop();
    expect(executions).toBe(1);

    // Replaying the same id against rebuilt state must return the durable
    // result rather than running the function again.
    const second = new Resonate({ network: makeNetwork({ log, sweepInterval: 50 }) });
    const again = second.register("counted", function* () {
      executions += 1;
      return "done";
    });
    await expect(again.run("dedup-1")).resolves.toBe("done");
    expect(executions).toBe(1);
    await second.stop();
  });
});

describe("timeout sweeping", () => {
  test("a promise past its deadline is settled by the sweeper", async () => {
    let clock = 1_000_000;
    const network = makeNetwork({ sweepInterval: 10, now: () => clock });
    await network.init();

    await network.send({
      kind: "promise.create",
      head: { corrId: "c", version: "v" },
      data: { id: "expiring", timeoutAt: clock + 1000, param: {}, tags: {} },
    });

    // Nothing due yet.
    expect(await network.sweep(clock)).toBe(0);

    // Advance past the deadline and sweep explicitly, so the assertion does not
    // race the interval timer.
    clock += 5000;
    expect(await network.sweep(clock)).toBeGreaterThan(0);

    const res = await network.send({
      kind: "promise.get",
      head: { corrId: "c", version: "v" },
      data: { id: "expiring" },
    });
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.data.promise.state).toBe("rejected_timedout");
    }
  });

  test("a timer promise resolves rather than times out", async () => {
    let clock = 1_000_000;
    const network = makeNetwork({ sweepInterval: 10, now: () => clock });
    await network.init();

    await network.send({
      kind: "promise.create",
      head: { corrId: "c", version: "v" },
      data: { id: "timer", timeoutAt: clock + 1000, param: {}, tags: { "resonate:timer": "true" } },
    });

    clock += 5000;
    await network.sweep(clock);

    const res = await network.send({
      kind: "promise.get",
      head: { corrId: "c", version: "v" },
      data: { id: "timer" },
    });
    if (isSuccess(res)) {
      expect(res.data.promise.state).toBe("resolved");
    }
  });

  test("sweeping is idempotent across concurrent processes", async () => {
    // Two networks over one log, both sweeping. The second must find nothing
    // left to do — redundant sweeps commit nothing, which is what makes
    // leader election unnecessary.
    let clock = 1_000_000;
    const log = new MemoryLog();
    const a = makeNetwork({ log, sweepInterval: 100_000, now: () => clock });
    const b = makeNetwork({ log, sweepInterval: 100_000, now: () => clock });

    await a.send({
      kind: "promise.create",
      head: { corrId: "c", version: "v" },
      data: { id: "shared", timeoutAt: clock + 1000, param: {}, tags: {} },
    });

    clock += 5000;
    const firstSweep = await a.sweep(clock);
    const secondSweep = await b.sweep(clock);

    expect(firstSweep).toBeGreaterThan(0);
    expect(secondSweep).toBe(0);
  });
});

describe("message addressing", () => {
  test("a process only receives messages addressed to it", async () => {
    const log = new MemoryLog();
    const mine = makeNetwork({ log, group: "default", pid: "me", sweepInterval: 100_000 });
    await mine.init();

    const received: string[] = [];
    mine.recv((msg) => received.push(msg.kind));

    // A promise targeting this group produces an execute message for it.
    await mine.send({
      kind: "promise.create",
      head: { corrId: "c", version: "v" },
      data: {
        id: "addressed",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:target": "local://any@default" },
      },
    });
    expect(received).toEqual(["execute"]);

    // A promise targeting a different group must not reach us.
    received.length = 0;
    await mine.send({
      kind: "promise.create",
      head: { corrId: "c", version: "v" },
      data: {
        id: "elsewhere",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:target": "local://any@other-group" },
      },
    });
    expect(received).toEqual([]);
  });
});
