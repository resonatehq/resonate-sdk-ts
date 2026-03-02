import { describe, expect, test } from "@jest/globals";
import { WallClock } from "../src/clock.js";
import { Codec } from "../src/codec.js";
import { Computation, type Status } from "../src/computation.js";
import type { Context } from "../src/context.js";
import type { ClaimedTask } from "../src/core.js";
import type { Heartbeat } from "../src/heartbeat.js";
import { LocalNetwork } from "../src/network/local.js";
import type { Network } from "../src/network/network.js";
import type { PromiseRecord } from "../src/network/types.js";
import { OptionsBuilder } from "../src/options.js";
import { AsyncProcessor } from "../src/processor/processor.js";
import { Registry } from "../src/registry.js";
import { Exponential, Never } from "../src/retries.js";
import type { Effects, Result } from "../src/types.js";
import * as util from "../src/util.js";

class TestHeartbeat implements Heartbeat {
  start(): void {}
  stop(): void {}
}

function buildComputation(registry: Registry): {
  computation: Computation;
  network: Network;
  effects: Effects;
} {
  const network = new LocalNetwork();
  const codec = new Codec();
  const transport = util.buildTransport(network);

  const effects = util.buildEffects(transport.send, codec);

  const computation = new Computation(
    "test-computation",
    new WallClock(),
    effects,
    new Map<string, any>([
      ["exponential", Exponential],
      ["never", Never],
    ]),
    registry,
    new TestHeartbeat(),
    new Map(),
    new OptionsBuilder({ match: (target: string) => target, idPrefix: "test-" }),
    false,
    new AsyncProcessor(),
  );

  return { computation, network, effects };
}

function runUntilBlocked(computation: Computation, task: ClaimedTask): Promise<Result<Status, undefined>> {
  return new Promise((resolve) => {
    computation.executeUntilBlocked(task, resolve);
  });
}

function createClaimedTask(
  id: string,
  func: string,
  args: any[],
  opts?: { version?: number; tags?: Record<string, string>; retry?: { type: string; data: any } },
): ClaimedTask {
  const now = Date.now();
  const rootPromise: PromiseRecord = {
    id,
    state: "pending",
    param: {
      headers: {},
      data: {
        func,
        args,
        version: opts?.version ?? 1,
        ...(opts?.retry && { retry: opts.retry }),
      } as any,
    },
    tags: {
      "resonate:target": "default",
      ...opts?.tags,
    },
    timeoutAt: now + 60_000,
    createdAt: now,
    value: { headers: {}, data: undefined },
  };

  return {
    kind: "claimed",
    task: { id, state: "acquired" as const, version: 1 },
    rootPromise,
  };
}

describe("Computation", () => {
  describe("only local todos", () => {
    test("single ctx.run completes with resolved value", async () => {
      function add(_ctx: Context, a: number, b: number) {
        return a + b;
      }

      function* main(ctx: Context) {
        const result: number = yield* ctx.run(add, 3, 4);
        return result;
      }

      const registry = new Registry();
      registry.add(main, "main");
      registry.add(add, "add");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("local-single", "main", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
        if (res.value.kind === "done") {
          expect(res.value.state).toBe("resolved");
          expect(res.value.value).toBe(7);
        }
      }
    });

    test("multiple ctx.run calls complete with final value", async () => {
      function double(_ctx: Context, n: number) {
        return n * 2;
      }

      function square(_ctx: Context, n: number) {
        return n * n;
      }

      function* main(ctx: Context) {
        const a: number = yield* ctx.run(double, 5);
        const b: number = yield* ctx.run(square, 3);
        return a + b;
      }

      const registry = new Registry();
      registry.add(main, "main");
      registry.add(double, "double");
      registry.add(square, "square");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("local-multi", "main", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
        if (res.value.kind === "done") {
          expect(res.value.state).toBe("resolved");
          expect(res.value.value).toBe(19);
        }
      }
    });
  });

  describe("only remote todos", () => {
    test("single ctx.rpc suspends with awaited id", async () => {
      function* main(ctx: Context) {
        const result: number = yield* ctx.rpc<number>("remoteFunc");
        return result;
      }

      const registry = new Registry();
      registry.add(main, "main");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("remote-single", "main", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("suspended");
        if (res.value.kind === "suspended") {
          expect(res.value.awaited).toHaveLength(1);
        }
      }
    });

    test("multiple ctx.beginRpc suspends with multiple awaited ids", async () => {
      function* main(ctx: Context) {
        yield* ctx.beginRpc("remoteA");
        yield* ctx.beginRpc("remoteB");
        return 0;
      }

      const registry = new Registry();
      registry.add(main, "main");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("remote-multi", "main", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("suspended");
        if (res.value.kind === "suspended") {
          expect(res.value.awaited).toHaveLength(2);
        }
      }
    });
  });

  describe("mix of local and remote todos", () => {
    test("local todo is processed first then suspends on remote", async () => {
      function add(_ctx: Context, a: number, b: number) {
        return a + b;
      }

      function* main(ctx: Context) {
        const local: number = yield* ctx.run(add, 1, 2);
        const remote: number = yield* ctx.rpc<number>("remoteFunc");
        return local + remote;
      }

      const registry = new Registry();
      registry.add(main, "main");
      registry.add(add, "add");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("mixed", "main", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("suspended");
        if (res.value.kind === "suspended") {
          expect(res.value.awaited).toHaveLength(1);
        }
      }
    });

    test("beginRun (local) and beginRpc (remote) in parallel, processes local first", async () => {
      function multiply(_ctx: Context, a: number, b: number) {
        return a * b;
      }

      function* main(ctx: Context) {
        const localFuture = yield* ctx.beginRun(multiply, 3, 7);
        const remoteFuture = yield* ctx.beginRpc<number>("remoteFunc");
        const localVal = yield* localFuture;
        const remoteVal = yield* remoteFuture;
        return localVal + remoteVal;
      }

      const registry = new Registry();
      registry.add(main, "main");
      registry.add(multiply, "multiply");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("mixed-parallel", "main", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("suspended");
        if (res.value.kind === "suspended") {
          expect(res.value.awaited).toHaveLength(1);
        }
      }
    });
  });

  describe("regular function (non-generator)", () => {
    test("resolves with the returned value", async () => {
      async function add(ctx: Context, a: number, b: number) {
        return a + b;
      }

      const registry = new Registry();
      registry.add(add, "add");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("func-resolve", "add", [3, 4]);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
        if (res.value.kind === "done") {
          expect(res.value.state).toBe("resolved");
          expect(res.value.value).toBe(7);
        }
      }
    });

    test("rejects when the function throws", async () => {
      async function fail(_ctx: Context) {
        throw new Error("boom");
      }

      const registry = new Registry();
      registry.add(fail, "fail");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("func-reject", "fail", [], { version: 1, retry: { type: "never", data: {} } });
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
        if (res.value.kind === "done") {
          expect(res.value.state).toBe("rejected");
          expect(res.value.value).toBeInstanceOf(Error);
          expect((res.value.value as Error).message).toBe("boom");
        }
      }
    });

    test("resolves with undefined when function returns nothing", async () => {
      async function noop(_ctx: Context) {}

      const registry = new Registry();
      registry.add(noop, "noop");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("func-void", "noop", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
        if (res.value.kind === "done") {
          expect(res.value.state).toBe("resolved");
          expect(res.value.value).toBeUndefined();
        }
      }
    });

    test("passes arguments correctly", async () => {
      async function concat(_ctx: Context, a: string, b: string, c: string) {
        return `${a}-${b}-${c}`;
      }

      const registry = new Registry();
      registry.add(concat, "concat");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("func-args", "concat", ["x", "y", "z"]);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
        if (res.value.kind === "done") {
          expect(res.value.state).toBe("resolved");
          expect(res.value.value).toBe("x-y-z");
        }
      }
    });
  });

  describe("error handling", () => {
    test("local function that throws results in rejected", async () => {
      function fail(_ctx: Context) {
        throw new Error("boom");
      }

      function* main(ctx: Context) {
        const result = yield* ctx.run(fail, ctx.options({ retryPolicy: new Never() }));
        return result;
      }

      const registry = new Registry();
      registry.add(main, "main");
      registry.add(fail, "fail");

      const { computation } = buildComputation(registry);
      const task = createClaimedTask("error-local", "main", []);
      const res = await runUntilBlocked(computation, task);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
        if (res.value.kind === "done") {
          expect(res.value.state).toBe("rejected");
        }
      }
    });
  });
});
