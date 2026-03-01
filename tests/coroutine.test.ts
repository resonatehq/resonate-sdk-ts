import { WallClock } from "../src/clock.js";
import { Codec } from "../src/codec.js";
import { type Context, InnerContext } from "../src/context.js";
import { Coroutine, type Suspended } from "../src/coroutine.js";
import type { PromiseRecord, Request, Response } from "../src/network/types.js";
import { OptionsBuilder } from "../src/options.js";
import { Registry } from "../src/registry.js";
import { Never } from "../src/retries.js";
import type { Effects, Result, Send } from "../src/types.js";
import * as util from "../src/util.js";

class DummyNetwork {
  private promises = new Map<string, PromiseRecord>();

  send: Send = <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
  ): void => {
    switch (req.kind) {
      case "promise.create": {
        const createReq = req as Extract<Request, { kind: "promise.create" }>;
        const existing = this.promises.get(createReq.data.id);
        if (existing) {
          callback({
            kind: req.kind,
            head: { corrId: req.head.corrId, status: 200, version: req.head.version },
            data: { promise: existing },
          } as Extract<Response, { kind: K }>);
          return;
        }
        const p: PromiseRecord = {
          id: createReq.data.id,
          state: "pending",
          timeoutAt: createReq.data.timeoutAt,
          param: createReq.data.param,
          value: { headers: {}, data: "" },
          tags: createReq.data.tags,
          createdAt: Date.now(),
        };
        this.promises.set(p.id, p);
        callback({
          kind: req.kind,
          head: { corrId: req.head.corrId, status: 200, version: req.head.version },
          data: { promise: p },
        } as Extract<Response, { kind: K }>);
        return;
      }

      case "promise.settle": {
        const settleReq = req as Extract<Request, { kind: "promise.settle" }>;
        const p = this.promises.get(settleReq.data.id)!;
        p.state = "resolved";
        p.value = settleReq.data.value;
        this.promises.set(p.id, p);
        callback({
          kind: req.kind,
          head: { corrId: req.head.corrId, status: 200, version: req.head.version },
          data: { promise: p },
        } as Extract<Response, { kind: K }>);
        break;
      }
      default:
        throw new Error("All other kind will not be implemented");
    }
  };
}

function buildEffects(network: DummyNetwork): Effects {
  const codec = new Codec();
  return util.buildEffects(network.send, codec);
}

describe("Coroutine", () => {
  const exec = async (uuid: string, func: (ctx: Context, ...args: any[]) => any, args: any[], effects: Effects) => {
    const res = await Coroutine.exec(
      false,
      new InnerContext({
        id: uuid,
        oId: uuid,
        func: func.name,
        clock: new WallClock(),
        registry: new Registry(),
        dependencies: new Map(),
        timeout: 0,
        version: 1,
        retryPolicy: new Never(),
        optsBuilder: new OptionsBuilder({ match: (t) => t, idPrefix: "" }),
      }),
      func,
      args,
      effects,
    );

    expect(res.kind).toBe("value");
    util.assert(res.kind === "value");
    return res.value;
  };

  const completePromise = async (effects: Effects, id: string, result: Result<any, any>) => {
    const res = await effects.promiseSettle({
      kind: "promise.settle",
      head: { corrId: "", version: "" },
      data: {
        id: id,
        state: result.kind === "value" ? "resolved" : "rejected",
        value: {
          headers: {},
          data: result.kind === "value" ? result.value : result.error,
        },
      },
    });

    expect(res.kind).toBe("value");
    util.assert(res.kind === "value");
    return res.value;
  };

  test("basic coroutine completes with done", async () => {
    function* bar() {
      return 42;
    }

    function* foo(ctx: Context) {
      const p = yield* ctx.beginRun(bar);
      const v = yield* p;
      return v;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);
    const r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 42 } });
  });

  test("basic coroutine with function suspends after first await", async () => {
    function bar() {
      return 42;
    }
    function baz() {
      return 31416;
    }

    function* foo(ctx: Context) {
      const p = yield* ctx.beginRun(bar);
      const p2 = yield* ctx.beginRun(baz);
      const v = yield* p;
      const v2 = yield* p2;
      return v + v2;
    }
    const network = new DummyNetwork();
    const effects = buildEffects(network);

    // First execution - should suspend
    let r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "suspended" });
    const suspended = r as Suspended;
    expect(suspended.todo.local).toHaveLength(2);

    await completePromise(effects, "foo.1.0", { kind: "value", value: 42 });
    await completePromise(effects, "foo.1.1", { kind: "value", value: 31416 });

    // Second execution - should complete
    r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 31458 } });
  });

  test("coroutine with a suspension point suspends if can not make more progress", async () => {
    function* bar() {
      return 42;
    }

    function* foo(ctx: Context) {
      const p1 = yield* ctx.beginRun(bar);
      const p2 = yield* ctx.beginRpc("bar");
      const v1 = yield* p1;
      yield* p1;
      yield* p2;
      return v1;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);

    let r = await exec("foo.1", foo, [], effects);
    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(effects, "foo.1.1", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 42 } });
  });

  test("Structured concurrency", async () => {
    function* bar() {
      return 42;
    }

    function* foo(ctx: Context) {
      yield* ctx.beginRpc("bar");
      yield* ctx.beginRpc("bar");
      return 99;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);
    let r = await exec("foo.1", foo, [], effects);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(2);

    await completePromise(effects, "foo.1.1", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], effects);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(effects, "foo.1.0", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], effects);

    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 99 } });
  });

  test("Structured concurrency with local non-generator fire-and-forget", async () => {
    function bar() {
      return 10;
    }
    function baz() {
      return 20;
    }

    function* foo(ctx: Context) {
      // Spawn two local (non-generator) tasks without awaiting the returned futures
      yield* ctx.beginRun(bar);
      yield* ctx.beginRun(baz);
      return 99;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);

    // First execution: generator reaches `return 99` with two pending local todos
    let r = await exec("foo.1", foo, [], effects);
    expect(r.type).toBe("suspended");
    const suspended = r as Suspended;
    expect(suspended.todo.local).toHaveLength(2);
    expect(suspended.todo.remote).toHaveLength(0);

    // Settle both local promises
    await completePromise(effects, "foo.1.0", { kind: "value", value: 10 });
    await completePromise(effects, "foo.1.1", { kind: "value", value: 20 });

    // Second execution: no pending todos at return → done
    r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 99 } });
  });

  test("Structured concurrency with mixed local and remote fire-and-forget", async () => {
    function bar() {
      return 10;
    }

    function* foo(ctx: Context) {
      // Spawn one local (non-generator) task and one remote task without awaiting
      yield* ctx.beginRun(bar);
      yield* ctx.beginRpc("someRemote");
      return 77;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);

    // First execution: both local and remote todos are pending at return
    let r = await exec("foo.1", foo, [], effects);
    expect(r.type).toBe("suspended");
    const suspended = r as Suspended;
    expect(suspended.todo.local).toHaveLength(1);
    expect(suspended.todo.remote).toHaveLength(1);

    // Settle the remote promise only
    await completePromise(effects, "foo.1.1", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], effects);
    // Still suspended because the local todo is pending
    expect(r.type).toBe("suspended");
    expect((r as Suspended).todo.local).toHaveLength(1);
    expect((r as Suspended).todo.remote).toHaveLength(0);

    // Settle the local promise
    await completePromise(effects, "foo.1.0", { kind: "value", value: 10 });
    r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 77 } });
  });

  test("Structured concurrency not triggered when inner generator completes inline", async () => {
    // When beginRun is used with a generator function and that generator
    // resolves without any pending RPCs, the coroutine settles it inline
    // so there are no pending todos at the time the parent returns.
    function* child() {
      return 55;
    }

    function* foo(ctx: Context) {
      // Spawn a generator that completes entirely inline (no RPCs inside)
      yield* ctx.beginRun(child);
      return 88;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);

    // The child generator completes inline, so no pending todos exist when
    // foo returns → should complete in a single execution without suspending.
    const r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 88 } });
  });

  test("Detached concurrency", async () => {
    function* bar() {
      return 42;
    }

    function* foo(ctx: Context) {
      yield* ctx.beginRpc("bar");
      yield* ctx.detached("bar");
      return 99;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);
    let r = await exec("foo.1", foo, [], effects);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(effects, "foo.1.0", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], effects);

    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 99 } });
  });

  test("Return the detached todo if explicitly awaited", async () => {
    function* bar() {
      return 42;
    }

    function* foo(ctx: Context) {
      yield* ctx.beginRpc("bar");
      const df = yield* ctx.detached("bar");
      const v = yield* df;
      return v;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);
    let r = await exec("foo.1", foo, [], effects);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(2);

    await completePromise(effects, "foo.1.0", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], effects);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(effects, "foo.1.1", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], effects);

    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 42 } });
  });

  test("lfc/rfc", async () => {
    function* bar() {
      return 42;
    }

    function* foo(ctx: Context) {
      const v1: number = yield* ctx.run(bar);
      const v2: number = yield* ctx.rpc<number>("bar");
      return v1 + v2;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);

    let r = await exec("foo.1", foo, [], effects);
    expect(r.type).toBe("suspended");
    const suspended = r as Suspended;
    expect(suspended.todo.remote).toHaveLength(1);

    await completePromise(effects, "foo.1.1", { kind: "value", value: 42 });

    r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 84 } });
  });

  test("DIE with condition true aborts execution", async () => {
    const originalError = console.error;
    console.error = () => {};

    function* foo(ctx: Context) {
      yield* ctx.panic(true, "Abort execution");
      return 42;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);

    const result = await Coroutine.exec(
      false,
      new InnerContext({
        id: "foo.1",
        func: foo.name,
        clock: new WallClock(),
        registry: new Registry(),
        dependencies: new Map(),
        timeout: 0,
        version: 1,
        retryPolicy: new Never(),
        optsBuilder: new OptionsBuilder({ match: (t) => t, idPrefix: "" }),
      }),
      foo,
      [],
      effects,
    );

    expect(result.kind).toBe("error");

    console.error = originalError;
  });

  test("DIE with condition false continues execution", async () => {
    function* foo(ctx: Context) {
      yield* ctx.panic(false, "Should not abort");
      return 42;
    }

    const network = new DummyNetwork();
    const effects = buildEffects(network);
    const r = await exec("foo.1", foo, [], effects);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 42 } });
  });
});
