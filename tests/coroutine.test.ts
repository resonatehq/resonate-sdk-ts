import { WallClock } from "../src/clock.js";
import { type Context, InnerContext } from "../src/context.js";
import { Coroutine, type Done, type Suspended } from "../src/coroutine.js";
import { JsonEncoder } from "../src/encoder.js";
import { NoopEncryptor } from "../src/encryptor.js";
import { Handler } from "../src/handler.js";
import type { Network } from "../src/network/network.js";
import type { Message, PromiseRecord, Request, Response } from "../src/network/types.js";
import { OptionsBuilder } from "../src/options.js";
import { Registry } from "../src/registry.js";
import { Never } from "../src/retries.js";
import { NoopSpan } from "../src/tracer.js";
import type { Result } from "../src/types.js";
import { assert } from "../src/util.js";

class DummyNetwork implements Network {
  private promises = new Map<string, PromiseRecord>();

  start(): void {}
  send<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
    headers?: { [key: string]: string },
    retryForever?: boolean,
  ): void {
    switch (req.kind) {
      case "promise.create": {
        const createReq = req as Extract<Request, { kind: "promise.create" }>;
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
  }

  recv(_msg: Message): void {
    throw new Error("Method not implemented.");
  }

  stop() {}
  subscribe(_t: "invoke" | "resume" | "notify", _c: (msg: Message) => void) {}
}

describe("Coroutine", () => {
  // Helper functions to write test easily
  const exec = (uuid: string, func: (ctx: Context, ...args: any[]) => any, args: any[], handler: Handler) => {
    const boundaryPromise: PromiseRecord = {
      id: uuid,
      state: "pending",
      param: { headers: {}, data: undefined },
      value: { headers: {}, data: undefined },
      tags: {},
      timeoutAt: 0,
      createdAt: Date.now(),
    };

    return new Promise<any>((resolve) => {
      Coroutine.exec(
        uuid,
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
          span: new NoopSpan(),
        }),
        func,
        args,
        { id: uuid, state: "acquired" as const, version: 1 },
        handler,
        new Map(),
        (res) => {
          expect(res.kind).toBe("value");
          assert(res.kind === "value");
          resolve(res.value);
        },
      );
    });
  };

  const completePromise = (handler: Handler, id: string, result: Result<any, any>) => {
    return new Promise<any>((resolve) => {
      handler.promiseSettle(
        {
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
        },
        (res) => {
          expect(res.kind).toBe("value");
          assert(res.kind === "value");
          resolve(res.value);
        },
      );
    });
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

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());
    const r = await exec("foo.1", foo, [], h);
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
    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());

    // First execution - should suspend
    let r = await exec("foo.1", foo, [], h);
    expect(r).toMatchObject({ type: "suspended" });
    const suspended = r as Suspended;
    expect(suspended.todo.local).toHaveLength(2);

    await completePromise(h, "foo.1.0", { kind: "value", value: 42 });
    await completePromise(h, "foo.1.1", { kind: "value", value: 31416 });

    // Second execution - should complete
    r = await exec("foo.1", foo, [], h);
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

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());

    let r = await exec("foo.1", foo, [], h);
    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(h, "foo.1.1", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], h);
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

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());
    let r = await exec("foo.1", foo, [], h);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(2);

    await completePromise(h, "foo.1.1", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], h);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(h, "foo.1.0", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], h);

    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 99 } });
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

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());
    let r = await exec("foo.1", foo, [], h);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(h, "foo.1.0", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], h);

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

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());
    let r = await exec("foo.1", foo, [], h);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(2);

    await completePromise(h, "foo.1.0", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], h);

    expect(r.type).toBe("suspended");
    r = r as Suspended;
    expect(r.todo.remote).toHaveLength(1);

    await completePromise(h, "foo.1.1", { kind: "value", value: 42 });
    r = await exec("foo.1", foo, [], h);

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

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());

    let r = await exec("foo.1", foo, [], h);
    expect(r.type).toBe("suspended");
    const suspended = r as Suspended;
    expect(suspended.todo.remote).toHaveLength(1);

    await completePromise(h, "foo.1.1", { kind: "value", value: 42 });

    r = await exec("foo.1", foo, [], h);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 84 } });
  });

  test("DIE with condition true aborts execution", async () => {
    function* foo(ctx: Context) {
      yield* ctx.panic(true, "Abort execution");
      return 42;
    }

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());

    const boundaryPromise: PromiseRecord = {
      id: "foo.1",
      state: "pending",
      param: { headers: {}, data: undefined },
      value: { headers: {}, data: undefined },
      tags: {},
      timeoutAt: 0,
      createdAt: Date.now(),
    };
    // DIE with condition=true causes callback to be called with err=true
    const result = await new Promise<Result<Suspended | Done, any>>((resolve) => {
      Coroutine.exec(
        "foo.1",
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
          span: new NoopSpan(),
        }),
        foo,
        [],
        { id: "foo.1", state: "acquired" as const, version: 1 },
        h,
        new Map(),
        (res) => {
          resolve(res);
        },
      );
    });

    expect(result.kind).toBe("error");
  });

  test("DIE with condition false continues execution", async () => {
    function* foo(ctx: Context) {
      yield* ctx.panic(false, "Should not abort");
      return 42;
    }

    const h = new Handler(new DummyNetwork(), new JsonEncoder(), new NoopEncryptor());
    const r = await exec("foo.1", foo, [], h);
    expect(r).toMatchObject({ type: "done", result: { kind: "value", value: 42 } });
  });
});
