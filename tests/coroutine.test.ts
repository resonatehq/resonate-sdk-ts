import { WallClock } from "../src/clock.js";
import { Codec } from "../src/codec.js";
import { type Context, InnerContext } from "../src/context.js";
import { Coroutine, type Done, type Suspended } from "../src/coroutine.js";
import type { Network } from "../src/network/network.js";
import type { Message, PromiseRecord, Request, Response } from "../src/network/types.js";
import { OptionsBuilder } from "../src/options.js";
import { Registry } from "../src/registry.js";
import { Never } from "../src/retries.js";
import type { Effects, Result } from "../src/types.js";
import * as util from "../src/util.js";

class DummyNetwork implements Network<Request, Response, Message> {
  readonly pid = "dummy";
  readonly group = "default";
  readonly unicast = "";
  readonly anycast = "";
  private promises = new Map<string, PromiseRecord>();

  start(): void {}
  subscribe(_t: "execute" | "notify", _c: (msg: Message) => void): void {}
  match(_target: string): string {
    return "";
  }
  send(
    req: Request,
    callback: (res: Response) => void,
    _headers?: { [key: string]: string },
    _retryForever?: boolean,
  ): void {
    switch (req.kind) {
      case "promise.create": {
        const createReq = req as Extract<Request, { kind: "promise.create" }>;
        const existing = this.promises.get(createReq.data.id);
        if (existing) {
          callback({
            kind: req.kind,
            head: { corrId: req.head.corrId, status: 200, version: req.head.version },
            data: { promise: existing },
          });
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
        });
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
        });
        break;
      }
      default:
        throw new Error("All other kind will not be implemented");
    }
  }

  stop() {}
}

function buildEffects(network: Network<Request, Response, Message>): Effects {
  const codec = new Codec();
  return util.buildEffects(network, codec);
}

describe("Coroutine", () => {
  // Helper functions to write test easily
  const exec = (uuid: string, func: (ctx: Context, ...args: any[]) => any, args: any[], effects: Effects) => {
    return new Promise<any>((resolve) => {
      Coroutine.exec(
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
        (res) => {
          expect(res.kind).toBe("value");
          util.assert(res.kind === "value");
          resolve(res.value);
        },
      );
    });
  };

  const completePromise = (effects: Effects, id: string, result: Result<any, any>) => {
    return new Promise<any>((resolve) => {
      effects.promiseSettle(
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
          util.assert(res.kind === "value");
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
        (res) => {
          resolve(res);
        },
      );
    });

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
