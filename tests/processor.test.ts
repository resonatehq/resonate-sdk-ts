import { WallClock } from "../src/clock.js";
import { InnerContext } from "../src/context.js";
import { OptionsBuilder } from "../src/options.js";
import { AsyncProcessor } from "../src/processor/processor.js";
import { Registry } from "../src/registry.js";
import type { RetryPolicy } from "../src/retries.js";
import { Constant, Never } from "../src/retries.js";

type WorkItem = {
  id: string;
  ctx: InnerContext;
  func: () => Promise<unknown>;
  verbose: boolean;
};

function buildCtx(id: string, retryPolicy: RetryPolicy = new Never()): InnerContext {
  return new InnerContext({
    id,
    func: id,
    clock: new WallClock(),
    registry: new Registry(),
    dependencies: new Map(),
    timeout: Date.now() + 60_000,
    version: 1,
    retryPolicy,
    optsBuilder: new OptionsBuilder({ match: (t) => t, idPrefix: "" }),
  });
}

function createWork(id: string, func: () => Promise<unknown>): WorkItem {
  return { id, ctx: buildCtx(id), func, verbose: false };
}

function createWorkWithRetry(id: string, func: () => Promise<unknown>, retryPolicy: RetryPolicy): WorkItem {
  return { id, ctx: buildCtx(id, retryPolicy), func, verbose: false };
}

describe("AsyncProcessor", () => {
  test("single work item - getReady returns its result", async () => {
    const processor = new AsyncProcessor();
    processor.process([createWork("a", async () => 42)]);

    const results = await processor.getReady(["a"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ id: "a", result: { kind: "value", value: 42 } });
  });

  test("multiple work items — getReady returns at least one", async () => {
    const processor = new AsyncProcessor();
    processor.process([
      createWork("a", async () => 1),
      createWork("b", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 2;
      }),
      createWork("c", async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 3;
      }),
    ]);

    const results = await processor.getReady(["a", "b", "c"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.result.kind).toBe("value");
    }
  });

  test("getReady called after all work completes - returns all results", async () => {
    const processor = new AsyncProcessor();
    processor.process([createWork("a", async () => 1), createWork("b", async () => 2)]);

    await new Promise((r) => setTimeout(r, 50));

    const results = await processor.getReady(["a", "b"]);
    expect(results).toHaveLength(2);
  });

  test("getReady called before work completes - waiter path", async () => {
    const processor = new AsyncProcessor();
    processor.process([
      createWork("a", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "delayed";
      }),
    ]);

    const results = await processor.getReady(["a"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toEqual({ id: "a", result: { kind: "value", value: "delayed" } });
  });

  test("duplicate process call while pending - no-op", async () => {
    const processor = new AsyncProcessor();

    processor.process([
      createWork("a", async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "first";
      }),
    ]);

    processor.process([createWork("a", async () => "second")]);

    const results = await processor.getReady(["a"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ id: "a", result: { kind: "value", value: "first" } });
  });

  test("duplicate process call after completion - no-op", async () => {
    const processor = new AsyncProcessor();
    processor.process([createWork("a", async () => "first")]);

    const results1 = await processor.getReady(["a"]);
    expect(results1[0]).toEqual({ id: "a", result: { kind: "value", value: "first" } });

    let secondFuncCalled = false;
    processor.process([
      createWork("a", async () => {
        secondFuncCalled = true;
        return "second";
      }),
    ]);

    await new Promise((r) => setTimeout(r, 50));
    expect(secondFuncCalled).toBe(false);
  });

  test("work item that throws - error result", async () => {
    const processor = new AsyncProcessor();
    const err = new Error("boom");
    processor.process([
      createWork("a", async () => {
        throw err;
      }),
    ]);

    const results = await processor.getReady(["a"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ id: "a", result: { kind: "error", error: err } });
  });

  test("mix of success and failure - getReady returns at least one", async () => {
    const processor = new AsyncProcessor();
    const err = new Error("fail");
    processor.process([
      createWork("a", async () => "ok"),
      createWork("b", async () => {
        throw err;
      }),
    ]);

    const results = await processor.getReady(["a", "b"]);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const map = new Map(results.map((r) => [r.id, r.result]));
    if (map.has("a")) {
      expect(map.get("a")).toEqual({ kind: "value", value: "ok" });
    }
    if (map.has("b")) {
      expect(map.get("b")).toEqual({ kind: "error", error: err });
    }
  });

  test("retry policy exhaustion - error result", async () => {
    const processor = new AsyncProcessor();
    let attempts = 0;
    const err = new Error("always fails");

    const work = createWorkWithRetry(
      "a",
      async () => {
        attempts++;
        throw err;
      },
      new Constant({ delay: 0, maxRetries: 1 }),
    );

    processor.process([work]);

    const results = await processor.getReady(["a"]);
    expect(results).toHaveLength(1);
    expect(results[0].result.kind).toBe("error");
    expect(attempts).toBeGreaterThan(1);
  });
});
