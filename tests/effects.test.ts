import { Codec } from "../src/codec.js";
import type { ResonateError } from "../src/exceptions.js";
import type { PromiseRecord, Request, Response } from "../src/network/types.js";
import type { Result, Send } from "../src/types.js";
import { buildEffects } from "../src/util.js";

// A simple in-memory stub that handles promise.create and promise.settle.
class StubNetwork {
  private promises = new Map<string, PromiseRecord>();
  sendCount = 0;

  send: Send = <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
  ): void => {
    this.sendCount++;

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
        p.state = settleReq.data.state;
        p.value = settleReq.data.value;
        p.settledAt = Date.now();
        this.promises.set(p.id, p);
        callback({
          kind: req.kind,
          head: { corrId: req.head.corrId, status: 200, version: req.head.version },
          data: { promise: p },
        } as Extract<Response, { kind: K }>);
        return;
      }

      default:
        throw new Error(`Unexpected request kind: ${req.kind}`);
    }
  };
}

const codec = new Codec();
const head = { corrId: "", version: "" };

function pendingPromise(id: string): PromiseRecord {
  return {
    id,
    state: "pending",
    param: codec.encode({ func: "f", args: [] }),
    value: { headers: {}, data: "" },
    tags: {},
    timeoutAt: Date.now() + 60_000,
    createdAt: Date.now(),
  };
}

function resolvedPromise(id: string, value: any): PromiseRecord {
  return {
    ...pendingPromise(id),
    state: "resolved",
    value: codec.encode(value),
    settledAt: Date.now(),
  };
}

function collect(
  fn: (done: (res: Result<PromiseRecord, ResonateError>) => void) => void,
): Promise<Result<PromiseRecord, ResonateError>> {
  return new Promise((resolve) => fn(resolve));
}

describe("Effects", () => {
  describe("promiseCreate", () => {
    test("returns cached promise from preload without hitting network", async () => {
      const network = new StubNetwork();
      const preloaded = pendingPromise("p1");
      const effects = buildEffects(network.send, codec, [preloaded]);

      const res = await collect((done) =>
        effects.promiseCreate(
          { kind: "promise.create", head, data: { id: "p1", timeoutAt: 0, param: { data: undefined }, tags: {} } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      expect(network.sendCount).toBe(0);
    });

    test("hits network when promise is not in preload", async () => {
      const network = new StubNetwork();
      const effects = buildEffects(network.send, codec);

      const res = await collect((done) =>
        effects.promiseCreate(
          {
            kind: "promise.create",
            head,
            data: { id: "p2", timeoutAt: Date.now() + 60_000, param: { data: { func: "f", args: [] } }, tags: {} },
          },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      expect(network.sendCount).toBe(1);
    });

    test("adds created promise to cache so second create is cached", async () => {
      const network = new StubNetwork();
      const effects = buildEffects(network.send, codec);

      // first call hits network
      await collect((done) =>
        effects.promiseCreate(
          {
            kind: "promise.create",
            head,
            data: { id: "p3", timeoutAt: Date.now() + 60_000, param: { data: { func: "f", args: [] } }, tags: {} },
          },
          done,
        ),
      );
      expect(network.sendCount).toBe(1);

      // second call should use cache
      const res = await collect((done) =>
        effects.promiseCreate(
          { kind: "promise.create", head, data: { id: "p3", timeoutAt: 0, param: { data: undefined }, tags: {} } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      expect(network.sendCount).toBe(1);
    });
  });

  describe("promiseSettle", () => {
    test("returns cached promise when already settled in preload", async () => {
      const network = new StubNetwork();
      const preloaded = resolvedPromise("s1", 42);
      const effects = buildEffects(network.send, codec, [preloaded]);

      const res = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "s1", state: "resolved", value: { data: 99 } } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.state).toBe("resolved");
      }
      expect(network.sendCount).toBe(0);
    });

    test("hits network when preloaded promise is still pending", async () => {
      const network = new StubNetwork();
      const preloaded = pendingPromise("s2");
      const effects = buildEffects(network.send, codec, [preloaded]);

      // seed the stub network so settle can find the promise
      network.send(
        {
          kind: "promise.create",
          head,
          data: { id: "s2", timeoutAt: Date.now() + 60_000, param: { data: "" }, tags: {} },
        },
        () => {},
      );
      const beforeCount = network.sendCount;

      const res = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "s2", state: "resolved", value: { data: "ok" } } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      expect(network.sendCount).toBe(beforeCount + 1);
    });

    test("updates cache after settling so second settle is cached", async () => {
      const network = new StubNetwork();
      const effects = buildEffects(network.send, codec);

      // create via network
      await collect((done) =>
        effects.promiseCreate(
          {
            kind: "promise.create",
            head,
            data: { id: "s3", timeoutAt: Date.now() + 60_000, param: { data: { func: "f", args: [] } }, tags: {} },
          },
          done,
        ),
      );
      expect(network.sendCount).toBe(1);

      // first settle hits network
      await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "s3", state: "resolved", value: { data: "v" } } },
          done,
        ),
      );
      expect(network.sendCount).toBe(2);

      // second settle should use cache (now settled)
      const res = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "s3", state: "resolved", value: { data: "v" } } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      expect(network.sendCount).toBe(2);
    });

    test("hits network when promise is not in cache at all", async () => {
      const network = new StubNetwork();
      const effects = buildEffects(network.send, codec);

      // seed the promise directly in the stub so settle doesn't crash
      network.send(
        {
          kind: "promise.create",
          head,
          data: { id: "s4", timeoutAt: Date.now() + 60_000, param: { data: "" }, tags: {} },
        },
        () => {},
      );
      const beforeCount = network.sendCount;

      const res = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "s4", state: "resolved", value: { data: "x" } } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      expect(network.sendCount).toBe(beforeCount + 1);
    });
  });

  describe("cached promise values", () => {
    test("preloaded pending promise has decoded param", async () => {
      const network = new StubNetwork();
      const preloaded = pendingPromise("v1");
      const effects = buildEffects(network.send, codec, [preloaded]);

      const res = await collect((done) =>
        effects.promiseCreate(
          { kind: "promise.create", head, data: { id: "v1", timeoutAt: 0, param: { data: undefined }, tags: {} } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.id).toBe("v1");
        expect(res.value.state).toBe("pending");
        expect(res.value.param.data).toEqual({ func: "f", args: [] });
      }
    });

    test("preloaded resolved promise has decoded value", async () => {
      const network = new StubNetwork();
      const preloaded = resolvedPromise("v2", { answer: 42 });
      const effects = buildEffects(network.send, codec, [preloaded]);

      const res = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "v2", state: "resolved", value: { data: "ignored" } } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.id).toBe("v2");
        expect(res.value.state).toBe("resolved");
        expect(res.value.value.data).toEqual({ answer: 42 });
      }
    });

    test("promise created via network has correct decoded values in cache", async () => {
      const network = new StubNetwork();
      const effects = buildEffects(network.send, codec);

      const paramData = { func: "myFunc", args: [1, "two"] };

      // first call goes to network and populates cache
      await collect((done) =>
        effects.promiseCreate(
          {
            kind: "promise.create",
            head,
            data: { id: "v3", timeoutAt: Date.now() + 60_000, param: { data: paramData }, tags: {} },
          },
          done,
        ),
      );

      // second call returns from cache
      const res = await collect((done) =>
        effects.promiseCreate(
          { kind: "promise.create", head, data: { id: "v3", timeoutAt: 0, param: { data: undefined }, tags: {} } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.id).toBe("v3");
        expect(res.value.state).toBe("pending");
        expect(res.value.param.data).toEqual(paramData);
      }
    });

    test("promise settled via network has correct decoded values in cache", async () => {
      const network = new StubNetwork();
      const effects = buildEffects(network.send, codec);

      // create promise via network
      await collect((done) =>
        effects.promiseCreate(
          {
            kind: "promise.create",
            head,
            data: { id: "v4", timeoutAt: Date.now() + 60_000, param: { data: { func: "f", args: [] } }, tags: {} },
          },
          done,
        ),
      );

      const settleValue = { result: "success", count: 7 };

      // settle via network, populates cache with settled state
      await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "v4", state: "resolved", value: { data: settleValue } } },
          done,
        ),
      );

      // second settle returns from cache
      const res = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "v4", state: "resolved", value: { data: "ignored" } } },
          done,
        ),
      );

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.id).toBe("v4");
        expect(res.value.state).toBe("resolved");
        expect(res.value.value.data).toEqual(settleValue);
      }
    });

    test("multiple preloaded promises each have correct values", async () => {
      const network = new StubNetwork();
      const p1 = pendingPromise("m1");
      const p2 = resolvedPromise("m2", "hello");
      const p3 = resolvedPromise("m3", [1, 2, 3]);
      const effects = buildEffects(network.send, codec, [p1, p2, p3]);

      const res1 = await collect((done) =>
        effects.promiseCreate(
          { kind: "promise.create", head, data: { id: "m1", timeoutAt: 0, param: { data: undefined }, tags: {} } },
          done,
        ),
      );
      const res2 = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "m2", state: "resolved", value: { data: "ignored" } } },
          done,
        ),
      );
      const res3 = await collect((done) =>
        effects.promiseSettle(
          { kind: "promise.settle", head, data: { id: "m3", state: "resolved", value: { data: "ignored" } } },
          done,
        ),
      );

      expect(network.sendCount).toBe(0);

      expect(res1.kind).toBe("value");
      if (res1.kind === "value") {
        expect(res1.value.state).toBe("pending");
        expect(res1.value.param.data).toEqual({ func: "f", args: [] });
      }

      expect(res2.kind).toBe("value");
      if (res2.kind === "value") {
        expect(res2.value.state).toBe("resolved");
        expect(res2.value.value.data).toBe("hello");
      }

      expect(res3.kind).toBe("value");
      if (res3.kind === "value") {
        expect(res3.value.state).toBe("resolved");
        expect(res3.value.value.data).toEqual([1, 2, 3]);
      }
    });
  });
});
