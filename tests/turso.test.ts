import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { type Context as AsyncContext, Resonate as AsyncResonate } from "../src/async/index.js";
import { type Context, Resonate } from "../src/index.js";
import {
  assertUrlSafeName,
  hashOrigin,
  originOf,
  ownerOf,
  TursoNetwork,
  tursoLocalDriver,
} from "../src/network/turso/index.js";
import type { Message, Request, Response } from "../src/network/types.js";
import { VERSION } from "../src/util.js";

// Every test drives the network directly, so the request head is boilerplate.
let corr = 0;
function head(extra: Record<string, unknown> = {}) {
  corr += 1;
  return { corrId: `c${corr}`, version: VERSION, ...extra } as Request["head"];
}

const TARGET = "poll://any@default";

/**
 * A network over one in-memory database per name. `connect(":memory:")` hands
 * back a fresh database per call and the store caches one connection per name,
 * so this gives real per-origin isolation without touching disk.
 */
function network(overrides: Record<string, unknown> = {}) {
  return new TursoNetwork({
    driver: tursoLocalDriver({ dir: ":memory:" }),
    prefix: "test-",
    tickMs: 5,
    retryTimeout: 1000,
    ...overrides,
  });
}

const open: TursoNetwork[] = [];
function tracked(overrides: Record<string, unknown> = {}): TursoNetwork {
  const net = network(overrides);
  open.push(net);
  return net;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.stop();
});

/** Collect messages the network delivers, so tests can await a specific one. */
function inbox(net: TursoNetwork) {
  const messages: Message[] = [];
  net.recv((msg) => messages.push(msg));
  return {
    messages,
    async next(predicate: (msg: Message) => boolean, timeoutMs = 2000): Promise<Message> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for message; saw ${JSON.stringify(messages)}`);
    },
  };
}

/** Assert a 2xx and narrow to the success arm so `data` is typed. */
function ok<R extends Response>(res: R): Extract<R, { head: { status: 200 } }> {
  if (res.head.status < 200 || res.head.status >= 300) {
    throw new Error(`expected success, got ${res.head.status}: ${JSON.stringify(res.data)}`);
  }
  return res as Extract<R, { head: { status: 200 } }>;
}

// =============================================================================
// ORIGIN
// =============================================================================

describe("originOf", () => {
  test("is the id up to the first dot", () => {
    expect(originOf("foo")).toBe("foo");
    expect(originOf("foo.1")).toBe("foo");
    expect(originOf("foo.1.2")).toBe("foo");
    expect(originOf("")).toBe("");
  });
});

describe("hashOrigin", () => {
  // Pinned, not computed. Every node in a fleet must agree on this — including
  // nodes running the Python SDK, whose `hash_origin` asserts the same vector —
  // so a change that quietly reshuffles ownership has to fail here first.
  test("matches the fixed vector shared with the Python SDK", () => {
    expect(hashOrigin("order-0")).toBe(713018330);
    expect(hashOrigin("order-1")).toBe(729795949);
    expect(hashOrigin("order-2")).toBe(679463092);
    expect(hashOrigin("acme")).toBe(1174237615);
    expect(hashOrigin("x.y")).toBe(3335537014);
    expect(hashOrigin("")).toBe(2166136261);
  });

  test("ownerOf spreads origins over the fleet and is stable", () => {
    expect(ownerOf("order-0", 2)).toBe(0);
    expect(ownerOf("order-1", 2)).toBe(1);
    const owners = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ownerOf(id, 3)));
    expect(owners.size).toBeGreaterThan(1);
  });
});

describe("shard configuration", () => {
  test("rejects a shard that cannot be an index into the fleet", () => {
    for (const shard of [
      { index: 2, count: 2 },
      { index: -1, count: 2 },
      { index: 0, count: 0 },
      { index: 0.5, count: 2 },
    ]) {
      expect(() => network({ shard })).toThrow(/Invalid shard/);
    }
    expect(() => network({ shard: { index: 1, count: 2 } })).not.toThrow();
  });
});

// =============================================================================
// PROMISES
// =============================================================================

describe("promises", () => {
  test("create is idempotent and get reads it back", async () => {
    const net = tracked();
    await net.init();

    const created = ok(
      await net.send({
        kind: "promise.create",
        head: head(),
        data: { id: "wf", timeoutAt: Date.now() + 60_000, param: { data: "hello" }, tags: {} },
      }),
    );
    expect(created.data.promise.state).toBe("pending");
    expect(created.data.promise.param.data).toBe("hello");

    // A second create with a different param returns the original.
    const again = ok(
      await net.send({
        kind: "promise.create",
        head: head(),
        data: { id: "wf", timeoutAt: Date.now() + 60_000, param: { data: "other" }, tags: {} },
      }),
    );
    expect(again.data.promise.param.data).toBe("hello");

    const got = ok(await net.send({ kind: "promise.get", head: head(), data: { id: "wf" } }));
    expect(got.data.promise.id).toBe("wf");
  });

  test("get of an unknown promise is 404", async () => {
    const net = tracked();
    await net.init();
    const res = await net.send({ kind: "promise.get", head: head(), data: { id: "nope" } });
    expect(res.head.status).toBe(404);
  });

  test("settle resolves and is idempotent", async () => {
    const net = tracked();
    await net.init();
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt: Date.now() + 60_000, param: {}, tags: {} },
    });

    const settled = ok(
      await net.send({
        kind: "promise.settle",
        head: head(),
        data: { id: "wf", state: "resolved", value: { data: 42 } },
      }),
    );
    expect(settled.data.promise.state).toBe("resolved");
    expect(settled.data.promise.value.data).toBe(42);

    const twice = ok(
      await net.send({
        kind: "promise.settle",
        head: head(),
        data: { id: "wf", state: "rejected", value: { data: "no" } },
      }),
    );
    expect(twice.data.promise.state).toBe("resolved");
    expect(twice.data.promise.value.data).toBe(42);
  });

  test("a promise created past its deadline is born settled", async () => {
    const net = tracked();
    await net.init();
    const res = ok(
      await net.send({
        kind: "promise.create",
        head: head(),
        data: { id: "late", timeoutAt: Date.now() - 1000, param: {}, tags: {} },
      }),
    );
    expect(res.data.promise.state).toBe("rejected_timedout");
    expect(res.data.promise.settledAt).toBe(res.data.promise.timeoutAt);
  });

  test("a timer promise past its deadline is born resolved", async () => {
    const net = tracked();
    await net.init();
    const res = ok(
      await net.send({
        kind: "promise.create",
        head: head(),
        data: {
          id: "timer",
          timeoutAt: Date.now() - 1000,
          param: {},
          tags: { "resonate:timer": "true" },
        },
      }),
    );
    expect(res.data.promise.state).toBe("resolved");
  });

  test("a pending promise past its deadline reads as logically settled without a sweep", async () => {
    const net = tracked({ tickMs: 60_000 }); // no background sweep during this test
    await net.init();
    const now = Date.now();
    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: { id: "wf", timeoutAt: now + 1000, param: {}, tags: {} },
    });

    const res = ok(
      await net.send({
        kind: "promise.get",
        head: head({ "resonate:debug_time": now + 2000 }),
        data: { id: "wf" },
      }),
    );
    expect(res.data.promise.state).toBe("rejected_timedout");
    expect(res.data.promise.settledAt).toBe(now + 1000);
  });

  test("create validation rejects an id that escapes its origin", async () => {
    const net = tracked();
    await net.init();
    const res = await net.send({
      kind: "promise.create",
      head: head(),
      data: {
        id: "other.1",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:origin": "wf" },
      },
    });
    expect(res.head.status).toBe(400);
  });
});

// =============================================================================
// CALLBACKS AND LISTENERS
// =============================================================================

describe("callbacks and listeners", () => {
  test("a callback may only be registered against an external promise", async () => {
    const net = tracked();
    await net.init();
    const timeoutAt = Date.now() + 60_000;

    // Awaiter carries a target, so it is external and addressable.
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt, param: {}, tags: { "resonate:target": TARGET } },
    });
    // Awaited is internal: no target, not a timer, not tagged external.
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf.internal", timeoutAt, param: {}, tags: {} },
    });

    const res = await net.send({
      kind: "promise.register_callback",
      head: head(),
      data: { awaited: "wf.internal", awaiter: "wf" },
    });
    expect(res.head.status).toBe(422);
  });

  test("a callback may not cross origins", async () => {
    const net = tracked();
    await net.init();
    const res = await net.send({
      kind: "promise.register_callback",
      head: head(),
      data: { awaited: "other.1", awaiter: "wf" },
    });
    expect(res.head.status).toBe(400);
  });

  test("a listener is unblocked when the promise settles", async () => {
    const net = tracked();
    await net.init();
    const box = inbox(net);
    const timeoutAt = Date.now() + 60_000;

    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt, param: {}, tags: { "resonate:external": "true" } },
    });
    ok(
      await net.send({
        kind: "promise.register_listener",
        head: head(),
        data: { awaited: "wf", address: net.unicast },
      }),
    );
    await net.send({
      kind: "promise.settle",
      head: head(),
      data: { id: "wf", state: "resolved", value: { data: "done" } },
    });

    const msg = await box.next((m) => m.kind === "unblock");
    expect(msg.kind).toBe("unblock");
    if (msg.kind === "unblock") {
      expect(msg.data.promise.id).toBe("wf");
      expect(msg.data.promise.state).toBe("resolved");
    }
  });

  test("a listener address must be routable", async () => {
    const net = tracked();
    await net.init();
    await net.send({
      kind: "promise.create",
      head: head(),
      data: {
        id: "wf",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:external": "true" },
      },
    });
    const res = await net.send({
      kind: "promise.register_listener",
      head: head(),
      data: { awaited: "wf", address: "poll://default" },
    });
    expect(res.head.status).toBe(400);
  });
});

// =============================================================================
// TASKS
// =============================================================================

describe("tasks", () => {
  test("creating a targeted promise dispatches an execute message", async () => {
    const net = tracked();
    await net.init();
    const box = inbox(net);

    await net.send({
      kind: "promise.create",
      head: head(),
      data: {
        id: "wf",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });

    const msg = await box.next((m) => m.kind === "execute");
    expect(msg).toEqual({ kind: "execute", head: {}, data: { task: { id: "wf", version: 0 } } });
  });

  test("resonate:delay holds the first dispatch back", async () => {
    const net = tracked({ tickMs: 60_000 });
    await net.init();
    const box = inbox(net);
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: {
        id: "wf",
        timeoutAt: now + 60_000,
        param: {},
        tags: { "resonate:target": TARGET, "resonate:delay": String(now + 10_000) },
      },
    });

    // Nothing is dispatched while the delay is ahead...
    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 1000 } });
    expect(box.messages).toHaveLength(0);

    // ...and the retry timer's first firing is the first dispatch.
    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 11_000 } });
    const msg = await box.next((m) => m.kind === "execute");
    expect(msg.kind).toBe("execute");
  });

  test("acquire fences on version and cannot be replayed", async () => {
    const net = tracked();
    await net.init();
    await net.send({
      kind: "promise.create",
      head: head(),
      data: {
        id: "wf",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });

    const acquired = ok(
      await net.send({
        kind: "task.acquire",
        head: head(),
        data: { id: "wf", version: 0, pid: "p1", ttl: 30_000 },
      }),
    );
    expect(acquired.data.task.version).toBe(1);
    expect(acquired.data.task.state).toBe("acquired");

    const replay = await net.send({
      kind: "task.acquire",
      head: head(),
      data: { id: "wf", version: 0, pid: "p2", ttl: 30_000 },
    });
    expect(replay.head.status).toBe(409);
  });

  test("task.create claims a fresh workflow in one round trip", async () => {
    const net = tracked();
    await net.init();
    const res = ok(
      await net.send({
        kind: "task.create",
        head: head(),
        data: {
          pid: "p1",
          ttl: 30_000,
          action: {
            kind: "promise.create",
            head: head(),
            data: {
              id: "wf",
              timeoutAt: Date.now() + 60_000,
              param: {},
              tags: { "resonate:target": TARGET },
            },
          },
        },
      }),
    );
    expect(res.data.task?.state).toBe("acquired");
    expect(res.data.task?.version).toBe(1);
    expect(res.data.promise.state).toBe("pending");
  });

  test("suspend registers callbacks and settling the awaited resumes the task", async () => {
    const net = tracked();
    await net.init();
    const box = inbox(net);
    const timeoutAt = Date.now() + 60_000;

    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt, param: {}, tags: { "resonate:target": TARGET } },
    });
    ok(
      await net.send({
        kind: "task.acquire",
        head: head(),
        data: { id: "wf", version: 0, pid: "p1", ttl: 30_000 },
      }),
    );
    // A child the workflow will block on. It is external, so it may be awaited.
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf.child", timeoutAt, param: {}, tags: { "resonate:external": "true" } },
    });

    ok(
      await net.send({
        kind: "task.suspend",
        head: head(),
        data: {
          id: "wf",
          version: 1,
          actions: [
            {
              kind: "promise.register_callback",
              head: head(),
              data: { awaited: "wf.child", awaiter: "wf" },
            },
          ],
        },
      }),
    );

    const suspended = ok(await net.send({ kind: "task.get", head: head(), data: { id: "wf" } }));
    expect(suspended.data.task.state).toBe("suspended");

    await net.send({
      kind: "promise.settle",
      head: head(),
      data: { id: "wf.child", state: "resolved", value: { data: "child" } },
    });

    // Match the resumed version rather than "any execute": the create-time
    // dispatch of version 0 is also in this inbox, and messages are handed over
    // a turn of the event loop after their commit, so the two can interleave.
    const msg = await box.next((m) => m.kind === "execute" && m.data.task.version === 1);
    expect(msg).toEqual({ kind: "execute", head: {}, data: { task: { id: "wf", version: 1 } } });

    const resumed = ok(await net.send({ kind: "task.get", head: head(), data: { id: "wf" } }));
    expect(resumed.data.task.state).toBe("pending");
    expect(resumed.data.task.resumes).toBe(1);
  });

  test("suspending on an already-settled promise returns 300 instead of blocking", async () => {
    const net = tracked();
    await net.init();
    const timeoutAt = Date.now() + 60_000;

    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt, param: {}, tags: { "resonate:target": TARGET } },
    });
    await net.send({
      kind: "task.acquire",
      head: head(),
      data: { id: "wf", version: 0, pid: "p1", ttl: 30_000 },
    });
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf.child", timeoutAt, param: {}, tags: { "resonate:external": "true" } },
    });
    await net.send({
      kind: "promise.settle",
      head: head(),
      data: { id: "wf.child", state: "resolved", value: {} },
    });

    const res = await net.send({
      kind: "task.suspend",
      head: head(),
      data: {
        id: "wf",
        version: 1,
        actions: [{ kind: "promise.register_callback", head: head(), data: { awaited: "wf.child", awaiter: "wf" } }],
      },
    });
    expect(res.head.status).toBe(300);
  });

  test("fulfill settles the promise and retires the task", async () => {
    const net = tracked();
    await net.init();
    await net.send({
      kind: "promise.create",
      head: head(),
      data: {
        id: "wf",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });
    await net.send({
      kind: "task.acquire",
      head: head(),
      data: { id: "wf", version: 0, pid: "p1", ttl: 30_000 },
    });

    const res = ok(
      await net.send({
        kind: "task.fulfill",
        head: head(),
        data: {
          id: "wf",
          version: 1,
          action: {
            kind: "promise.settle",
            head: head(),
            data: { id: "wf", state: "resolved", value: { data: "out" } },
          },
        },
      }),
    );
    expect(res.data.promise.state).toBe("resolved");

    const task = ok(await net.send({ kind: "task.get", head: head(), data: { id: "wf" } }));
    expect(task.data.task.state).toBe("fulfilled");
  });

  test("fence lets an acquired task create a child, and refuses a stale version", async () => {
    const net = tracked();
    await net.init();
    const timeoutAt = Date.now() + 60_000;

    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt, param: {}, tags: { "resonate:target": TARGET } },
    });
    await net.send({
      kind: "task.acquire",
      head: head(),
      data: { id: "wf", version: 0, pid: "p1", ttl: 30_000 },
    });

    const fenced = ok(
      await net.send({
        kind: "task.fence",
        head: head(),
        data: {
          id: "wf",
          version: 1,
          action: {
            kind: "promise.create",
            head: head(),
            data: { id: "wf.child", timeoutAt, param: { data: "arg" }, tags: {} },
          },
        },
      }),
    );
    expect(fenced.data.action.head.status).toBe(200);

    const child = ok(await net.send({ kind: "promise.get", head: head(), data: { id: "wf.child" } }));
    expect(child.data.promise.param.data).toBe("arg");

    const stale = await net.send({
      kind: "task.fence",
      head: head(),
      data: {
        id: "wf",
        version: 0,
        action: {
          kind: "promise.create",
          head: head(),
          data: { id: "wf.other", timeoutAt, param: {}, tags: {} },
        },
      },
    });
    expect(stale.head.status).toBe(409);
  });

  test("halt takes a task out of circulation and continue puts it back", async () => {
    const net = tracked();
    await net.init();
    const box = inbox(net);
    await net.send({
      kind: "promise.create",
      head: head(),
      data: {
        id: "wf",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });

    ok(await net.send({ kind: "task.halt", head: head(), data: { id: "wf" } }));
    const halted = ok(await net.send({ kind: "task.get", head: head(), data: { id: "wf" } }));
    expect(halted.data.task.state).toBe("halted");

    box.messages.length = 0;
    ok(await net.send({ kind: "task.continue", head: head(), data: { id: "wf" } }));
    const msg = await box.next((m) => m.kind === "execute");
    expect(msg.kind).toBe("execute");
  });
});

// =============================================================================
// TIMEOUTS
// =============================================================================

describe("timeouts", () => {
  test("a due promise timeout settles the promise, retires the task and unblocks listeners", async () => {
    const net = tracked({ tickMs: 60_000 });
    await net.init();
    const box = inbox(net);
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: {
        id: "wf",
        timeoutAt: now + 1000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });
    ok(
      await net.send({
        kind: "promise.register_listener",
        head: head({ "resonate:debug_time": now }),
        data: { awaited: "wf", address: net.unicast },
      }),
    );

    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 2000 } });

    const promise = ok(
      await net.send({
        kind: "promise.get",
        head: head({ "resonate:debug_time": now + 2000 }),
        data: { id: "wf" },
      }),
    );
    expect(promise.data.promise.state).toBe("rejected_timedout");

    const task = ok(
      await net.send({
        kind: "task.get",
        head: head({ "resonate:debug_time": now + 2000 }),
        data: { id: "wf" },
      }),
    );
    expect(task.data.task.state).toBe("fulfilled");

    const msg = await box.next((m) => m.kind === "unblock");
    if (msg.kind === "unblock") expect(msg.data.promise.state).toBe("rejected_timedout");
  });

  test("an unclaimed task is redispatched when its retry interval elapses", async () => {
    const net = tracked({ tickMs: 60_000, retryTimeout: 1000 });
    await net.init();
    const box = inbox(net);
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: {
        id: "wf",
        timeoutAt: now + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });
    await box.next((m) => m.kind === "execute");
    box.messages.length = 0;

    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 1500 } });
    const msg = await box.next((m) => m.kind === "execute");
    expect(msg).toEqual({ kind: "execute", head: {}, data: { task: { id: "wf", version: 0 } } });
  });

  test("an expired lease returns the task to circulation", async () => {
    const net = tracked({ tickMs: 60_000, retryTimeout: 1000 });
    await net.init();
    const box = inbox(net);
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: {
        id: "wf",
        timeoutAt: now + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });
    await box.next((m) => m.kind === "execute");
    ok(
      await net.send({
        kind: "task.acquire",
        head: head({ "resonate:debug_time": now }),
        data: { id: "wf", version: 0, pid: "p1", ttl: 500 },
      }),
    );
    box.messages.length = 0;

    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 1000 } });

    const task = ok(
      await net.send({
        kind: "task.get",
        head: head({ "resonate:debug_time": now + 1000 }),
        data: { id: "wf" },
      }),
    );
    expect(task.data.task.state).toBe("pending");
    const msg = await box.next((m) => m.kind === "execute");
    expect(msg).toEqual({ kind: "execute", head: {}, data: { task: { id: "wf", version: 1 } } });
  });

  test("a lease on a logically dead task is not returned to circulation", async () => {
    const net = tracked({ tickMs: 60_000, retryTimeout: 1000 });
    await net.init();
    const box = inbox(net);
    const now = Date.now();

    // The promise deadline lands before the lease would expire.
    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: { id: "wf", timeoutAt: now + 400, param: {}, tags: { "resonate:target": TARGET } },
    });
    // Wait out the create-time dispatch before clearing, so anything left in
    // the inbox afterwards is genuinely a redispatch.
    await box.next((m) => m.kind === "execute");
    await net.send({
      kind: "task.acquire",
      head: head({ "resonate:debug_time": now }),
      data: { id: "wf", version: 0, pid: "p1", ttl: 500 },
    });
    box.messages.length = 0;

    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 1000 } });

    const task = ok(
      await net.send({
        kind: "task.get",
        head: head({ "resonate:debug_time": now + 1000 }),
        data: { id: "wf" },
      }),
    );
    expect(task.data.task.state).toBe("fulfilled");
    expect(box.messages.filter((m) => m.kind === "execute")).toHaveLength(0);
  });

  test("heartbeating an acquired task keeps its lease alive", async () => {
    const net = tracked({ tickMs: 60_000, retryTimeout: 1000 });
    await net.init();
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: {
        id: "wf",
        timeoutAt: now + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });
    await net.send({
      kind: "task.acquire",
      head: head({ "resonate:debug_time": now }),
      data: { id: "wf", version: 0, pid: "p1", ttl: 500 },
    });
    ok(
      await net.send({
        kind: "task.heartbeat",
        head: head({ "resonate:debug_time": now + 400 }),
        data: { pid: "p1", tasks: [{ id: "wf", version: 1 }] },
      }),
    );

    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 700 } });
    const task = ok(
      await net.send({
        kind: "task.get",
        head: head({ "resonate:debug_time": now + 700 }),
        data: { id: "wf" },
      }),
    );
    expect(task.data.task.state).toBe("acquired");
  });
});

// =============================================================================
// PARTITIONING
// =============================================================================

describe("partitioning", () => {
  test("each origin gets its own database file, named by the prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resonate-turso-"));
    const net = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "acme-",
      timeoutDatabase: "timers",
      tickMs: 60_000,
    });
    try {
      await net.init();
      const timeoutAt = Date.now() + 60_000;
      for (const id of ["alpha", "beta.1"]) {
        ok(
          await net.send({
            kind: "promise.create",
            head: head(),
            data: { id, timeoutAt, param: {}, tags: {} },
          }),
        );
      }

      const files = readdirSync(dir).filter((f) => f.endsWith(".db"));
      expect(files.sort()).toEqual(["acme-alpha.db", "acme-beta.db", "acme-timers.db"]);
    } finally {
      await net.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second process picks up work it never created, through the timeout index", async () => {
    // This is the whole recovery story now that messages are not queued. The
    // creator delivers the execute to itself and does nothing with it. The task
    // stays pending, its retry timer comes due, and the worker — which has never
    // heard of this workflow — finds it in the tenant timeout index, opens the
    // origin database the id names, and gets the execute delivered locally.
    const dir = mkdtempSync(join(tmpdir(), "resonate-turso-"));
    const creator = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "shared-",
      // Nothing swept by the creator, so the worker is the only sweeper.
      tickMs: 60_000,
      retryTimeout: 100,
    });
    const worker = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "shared-",
      tickMs: 5,
      retryTimeout: 100,
    });
    try {
      await creator.init();
      await worker.init();
      const workerBox = inbox(worker);
      const creatorBox = inbox(creator);

      ok(
        await creator.send({
          kind: "promise.create",
          head: head(),
          data: {
            id: "handoff",
            timeoutAt: Date.now() + 60_000,
            param: { data: "payload" },
            tags: { "resonate:target": creator.match("default") },
          },
        }),
      );

      // The creating process gets its own message, immediately and in process.
      const local = await creatorBox.next((m) => m.kind === "execute");
      expect(local).toEqual({ kind: "execute", head: {}, data: { task: { id: "handoff", version: 0 } } });

      // The worker gets it too, once the retry timer it swept comes due.
      const swept = await workerBox.next((m) => m.kind === "execute");
      expect(swept).toEqual({ kind: "execute", head: {}, data: { task: { id: "handoff", version: 0 } } });

      // The worker opens the origin database for the first time and claims it.
      const acquired = ok(
        await worker.send({
          kind: "task.acquire",
          head: head(),
          data: { id: "handoff", version: 0, pid: "worker-1", ttl: 30_000 },
        }),
      );
      expect(acquired.data.promise.param.data).toBe("payload");

      // And the creator sees the claim, because both read the same database.
      const seen = ok(await creator.send({ kind: "task.get", head: head(), data: { id: "handoff" } }));
      expect(seen.data.task.state).toBe("acquired");
      expect(seen.data.task.pid).toBe("worker-1");
    } finally {
      await creator.stop();
      await worker.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sharded node sweeps only the timers of the origins it owns", async () => {
    // The point of `shard`. Both nodes read one timeout index holding both
    // slices; each must act on its own and leave the other's alone, or two
    // nodes end up driving one workflow.
    const dir = mkdtempSync(join(tmpdir(), "resonate-turso-"));
    const ids = ["alpha", "beta", "gamma", "delta"];
    const mine = ids.filter((id) => ownerOf(id, 2) === 0);
    const theirs = ids.filter((id) => ownerOf(id, 2) === 1);
    // A useless test if the hash happens to send everything one way.
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);

    // Creates the work but never sweeps, so every execute below is swept.
    const creator = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "shard-",
      tickMs: 60_000,
      retryTimeout: 50,
    });
    const node0 = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "shard-",
      tickMs: 5,
      retryTimeout: 50,
      shard: { index: 0, count: 2 },
    });
    try {
      await creator.init();
      await node0.init();
      const box = inbox(node0);

      for (const id of ids) {
        ok(
          await creator.send({
            kind: "promise.create",
            head: head(),
            data: {
              id,
              timeoutAt: Date.now() + 60_000,
              param: {},
              tags: { "resonate:target": creator.match("default") },
            },
          }),
        );
      }

      // Everything this node owns arrives...
      for (const id of mine) await box.next((m) => m.kind === "execute" && (m.data as any).task.id === id);
      // ...and nothing else ever does, though its timer is equally overdue.
      await new Promise((r) => setTimeout(r, 300));
      const seen = box.messages.filter((m) => m.kind === "execute").map((m) => (m.data as any).task.id);
      expect([...new Set(seen)].sort()).toEqual([...mine].sort());
      for (const id of theirs) expect(seen).not.toContain(id);
    } finally {
      await node0.stop();
      await creator.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the tenant database can live on a driver of its own", async () => {
    // A fleet shares the timeout index but not its origins, so the two sides
    // must be able to point at different storage.
    const origins = mkdtempSync(join(tmpdir(), "resonate-turso-o-"));
    const timers = mkdtempSync(join(tmpdir(), "resonate-turso-t-"));
    const net = new TursoNetwork({
      driver: tursoLocalDriver({ dir: origins }),
      timeoutDriver: tursoLocalDriver({ dir: timers }),
      prefix: "split-",
      timeoutDatabase: "timers",
      tickMs: 60_000,
    });
    try {
      await net.init();
      ok(
        await net.send({
          kind: "promise.create",
          head: head(),
          data: { id: "wf", timeoutAt: Date.now() + 60_000, param: {}, tags: {} },
        }),
      );
      expect(readdirSync(origins).filter((f) => f.endsWith(".db"))).toEqual(["split-wf.db"]);
      expect(readdirSync(timers).filter((f) => f.endsWith(".db"))).toEqual(["split-timers.db"]);
    } finally {
      await net.stop();
      rmSync(origins, { recursive: true, force: true });
      rmSync(timers, { recursive: true, force: true });
    }
  });

  test("a message reaches the client without any table backing it", async () => {
    const net = tracked({ tickMs: 60_000 });
    await net.init();
    const box = inbox(net);

    await net.send({
      kind: "promise.create",
      head: head(),
      data: {
        id: "wf",
        timeoutAt: Date.now() + 60_000,
        param: {},
        tags: { "resonate:target": TARGET },
      },
    });

    // Delivered with no tick in between — the network's tick interval is set
    // past the life of this test, so nothing but the commit could have done it.
    await box.next((m) => m.kind === "execute");

    // And the snapshot confirms nothing is queued anywhere.
    const snap = ok(
      await net.send({
        kind: "debug.snap",
        head: head({ "resonate:origin": "wf" }),
        data: {},
      }),
    );
    expect(snap.data.messages).toEqual([]);
  });

  test("promises in different origins do not see each other", async () => {
    const net = tracked();
    await net.init();
    const timeoutAt = Date.now() + 60_000;

    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "alpha.1", timeoutAt, param: { data: "a" }, tags: { "resonate:origin": "alpha" } },
    });
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "beta.1", timeoutAt, param: { data: "b" }, tags: { "resonate:origin": "beta" } },
    });

    const alpha = ok(
      await net.send({
        kind: "promise.search",
        head: head(),
        data: { tags: { "resonate:origin": "alpha" } },
      }),
    );
    // The search is scoped to the alpha database, which holds only alpha's ids.
    expect(alpha.data.promises.map((p) => p.id)).toEqual(["alpha.1"]);
  });

  test("a tenant-wide search is refused rather than answered partially", async () => {
    const net = tracked();
    await net.init();
    const res = await net.send({ kind: "promise.search", head: head(), data: {} });
    expect(res.head.status).toBe(501);
  });

  test("a heartbeat spanning origins refreshes every one of them", async () => {
    const net = tracked({ tickMs: 60_000, retryTimeout: 1000 });
    await net.init();
    const now = Date.now();

    for (const id of ["alpha", "beta"]) {
      await net.send({
        kind: "promise.create",
        head: head({ "resonate:debug_time": now }),
        data: {
          id,
          timeoutAt: now + 60_000,
          param: {},
          tags: { "resonate:target": TARGET },
        },
      });
      await net.send({
        kind: "task.acquire",
        head: head({ "resonate:debug_time": now }),
        data: { id, version: 0, pid: "p1", ttl: 500 },
      });
    }

    ok(
      await net.send({
        kind: "task.heartbeat",
        head: head({ "resonate:debug_time": now + 400 }),
        data: {
          pid: "p1",
          tasks: [
            { id: "alpha", version: 1 },
            { id: "beta", version: 1 },
          ],
        },
      }),
    );

    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 700 } });
    for (const id of ["alpha", "beta"]) {
      const task = ok(
        await net.send({
          kind: "task.get",
          head: head({ "resonate:debug_time": now + 700 }),
          data: { id },
        }),
      );
      expect(task.data.task.state).toBe("acquired");
    }
  });
});

// =============================================================================
// SCHEDULES
// =============================================================================

describe("schedules", () => {
  test("create is idempotent, get reads it back, delete removes it", async () => {
    const net = tracked({ tickMs: 60_000 });
    await net.init();

    const created = ok(
      await net.send({
        kind: "schedule.create",
        head: head(),
        data: {
          id: "nightly",
          cron: "0 0 * * *",
          promiseId: "job.{{.timestamp}}",
          promiseTimeout: 60_000,
          promiseParam: {},
          promiseTags: { "resonate:target": TARGET },
        },
      }),
    );
    expect(created.data.schedule.id).toBe("nightly");
    expect(created.data.schedule.nextRunAt).toBeGreaterThan(Date.now());

    const got = ok(await net.send({ kind: "schedule.get", head: head(), data: { id: "nightly" } }));
    expect(got.data.schedule.cron).toBe("0 0 * * *");

    ok(await net.send({ kind: "schedule.delete", head: head(), data: { id: "nightly" } }));
    const gone = await net.send({ kind: "schedule.get", head: head(), data: { id: "nightly" } });
    expect(gone.head.status).toBe(404);
  });

  test("a schedule without a target is refused", async () => {
    const net = tracked({ tickMs: 60_000 });
    await net.init();
    const res = await net.send({
      kind: "schedule.create",
      head: head(),
      data: {
        id: "bad",
        cron: "* * * * *",
        promiseId: "job.{{.timestamp}}",
        promiseTimeout: 60_000,
        promiseParam: {},
        promiseTags: {},
      },
    });
    expect(res.head.status).toBe(400);
  });

  test("a due schedule fires its promise into the origin its id names", async () => {
    const net = tracked({ tickMs: 60_000 });
    await net.init();

    ok(
      await net.send({
        kind: "schedule.create",
        head: head(),
        data: {
          id: "every-minute",
          cron: "* * * * *",
          promiseId: "job.{{.id}}",
          promiseTimeout: 3_600_000,
          promiseParam: { data: "tick" },
          promiseTags: { "resonate:target": TARGET },
        },
      }),
    );

    // Two minutes on, the schedule is due.
    await net.send({ kind: "debug.tick", head: head(), data: { time: Date.now() + 120_000 } });

    const promise = ok(await net.send({ kind: "promise.get", head: head(), data: { id: "job.every-minute" } }));
    expect(promise.data.promise.param.data).toBe("tick");
    expect(promise.data.promise.tags["resonate:schedule"]).toBe("every-minute");
  });
});

// =============================================================================
// END TO END
// =============================================================================
//
// Everything above drives the network directly at the protocol level. These
// drive the SDK: a registered function, invoked durably, running to completion
// against Turso databases with no server anywhere.

describe("end to end", () => {
  test("a generator workflow runs to completion and can be re-attached to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resonate-e2e-"));
    const network = () => new TursoNetwork({ driver: tursoLocalDriver({ dir }), prefix: "e2e-", tickMs: 20 });

    const resonate = new Resonate({ network: network() });
    resonate.register("order", function* (ctx: Context, customer: string, amount: number): any {
      const ref = yield* ctx.run(async () => `CH-${amount}`);
      yield* ctx.sleep(30);
      return `${customer}:${ref}`;
    });

    let other: Resonate | undefined;
    try {
      expect(await resonate.run("order-1", "order", "acme", 100)).toBe("acme:CH-100");

      // A second client over the same databases sees the settled result.
      other = new Resonate({ network: network() });
      expect(await (await other.get("order-1")).result()).toBe("acme:CH-100");
    } finally {
      await other?.stop();
      await resonate.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a workflow abandoned mid-flight is finished by another process", async () => {
    // The recovery claim, end to end: A dies while its workflow is asleep, and
    // B — which has never seen this workflow — picks it up off the tenant
    // timeout index and runs it to completion.
    const dir = mkdtempSync(join(tmpdir(), "resonate-recover-"));
    const worker = (pid: string) => {
      const r = new Resonate({
        pid,
        network: new TursoNetwork({
          driver: tursoLocalDriver({ dir }),
          prefix: "rec-",
          pid,
          tickMs: 20,
          retryTimeout: 300,
        }),
      });
      r.register("job", function* (ctx: Context): any {
        const a = yield* ctx.run(async () => "step1");
        yield* ctx.sleep(200);
        const b = yield* ctx.run(async () => "step2");
        return `${a}+${b}`;
      });
      return r;
    };

    const a = worker("proc-a");
    let b: Resonate | undefined;
    try {
      await a.beginRun("job-1", "job");
      await new Promise((r) => setTimeout(r, 120));
      await a.stop();

      b = worker("proc-b");
      expect(await (await b.get("job-1")).result()).toBe("step1+step2");
    } finally {
      await b?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an async-engine workflow runs to completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resonate-async-"));
    const resonate = new AsyncResonate({
      network: new TursoNetwork({ driver: tursoLocalDriver({ dir }), prefix: "as-", tickMs: 20 }),
    });
    resonate.register("pipeline", async (ctx: AsyncContext, n: number) => {
      const doubled = await ctx.run(async () => n * 2);
      const plus = await ctx.run(async () => doubled + 1);
      await ctx.sleep(30);
      return `${n} -> ${plus}`;
    });

    try {
      const handle = await resonate.run("p-1", "pipeline", 21);
      expect(await handle.result()).toBe("21 -> 43");
    } finally {
      await resonate.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// =============================================================================
// REVIEW REGRESSIONS
// =============================================================================

describe("declared origin header", () => {
  test("a header carrying a full id is normalized to its origin", async () => {
    // The engine cores stamp resonate:origin with the full task id, not its
    // origin; routing must normalize it, or a dotted id becomes the name of a
    // phantom database and every such acquire answers 404.
    const net = tracked();
    await net.init();
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt: Date.now() + 60_000, param: {}, tags: { "resonate:target": TARGET } },
    });
    const acquired = await net.send({
      kind: "task.acquire",
      head: head({ "resonate:origin": "wf.some.dotted.task" }),
      data: { id: "wf", version: 0, pid: "p1", ttl: 30_000 },
    });
    expect(acquired.head.status).toBe(200);
  });

  test("a header that contradicts the id's origin is refused", async () => {
    // Honoring it would write one workflow's state into another workflow's
    // database — the one thing the partition must never do.
    const net = tracked();
    await net.init();
    const res = await net.send({
      kind: "promise.get",
      head: head({ "resonate:origin": "other" }),
      data: { id: "wf" },
    });
    expect(res.head.status).toBe(400);
  });
});

describe("fleet guardrails", () => {
  test("a sharded node refuses to join a fleet with a different shard count", async () => {
    // Ownership is hashOrigin(origin) % count, so a count disagreement leaves
    // some origins owned by nobody (their timers stay due forever, silently)
    // and others owned by two nodes. Neither shows up as an error anywhere,
    // which is why it is checked at startup.
    const dir = mkdtempSync(join(tmpdir(), "resonate-turso-"));
    const node0 = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "agree-",
      tickMs: 60_000,
      shard: { index: 0, count: 2 },
    });
    const wrong = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "agree-",
      tickMs: 60_000,
      shard: { index: 0, count: 3 },
    });
    try {
      await node0.init();
      await expect(wrong.init()).rejects.toThrow(/Shard count mismatch/);
      // The same count is admitted.
      const right = new TursoNetwork({
        driver: tursoLocalDriver({ dir }),
        prefix: "agree-",
        tickMs: 60_000,
        shard: { index: 1, count: 2 },
      });
      await right.init();
      await right.stop();
    } finally {
      await node0.stop();
      await wrong.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("database names", () => {
  test("a URL-addressed driver refuses a name that would redirect the URL", () => {
    // An origin comes verbatim from a caller-supplied promise id, and the
    // protocol only forbids '.' there — so `libsql://acme-` + `jobs/admin`
    // would silently address database `acme-jobs`, a different tenant's.
    expect(() => assertUrlSafeName("jobs/admin")).toThrow(/Invalid database name/);
    expect(() => assertUrlSafeName("wf?x=1")).toThrow(/Invalid database name/);
    expect(() => assertUrlSafeName("wf#frag")).toThrow(/Invalid database name/);
    expect(() => assertUrlSafeName("a@b")).toThrow(/Invalid database name/);
    expect(() => assertUrlSafeName("")).toThrow(/Invalid database name/);
    expect(() => assertUrlSafeName("order-42")).not.toThrow();
  });
});

describe("search projection", () => {
  test("search filters on the state it reports, for a promise that never converges", async () => {
    // An internal promise arms no durable timeout, so its stored row stays
    // 'pending' forever while its projected state is 'rejected_timedout'.
    // Filtering on the stored column would return it under state='pending'
    // reporting 'rejected_timedout', and never under its real state.
    const net = tracked();
    await net.init();
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf", timeoutAt: Date.now() + 60_000, param: {}, tags: {} },
    });
    // A child with a deadline already in the past: internal, so nothing ever
    // converges the stored row.
    await net.send({
      kind: "promise.create",
      head: head(),
      data: { id: "wf.step", timeoutAt: Date.now() - 1000, param: {}, tags: {} },
    });

    const pending = ok(
      await net.send({ kind: "promise.search", head: head({ "resonate:origin": "wf" }), data: { state: "pending" } }),
    );
    expect(pending.data.promises.map((p: any) => p.id)).not.toContain("wf.step");

    const timedOut = ok(
      await net.send({
        kind: "promise.search",
        head: head({ "resonate:origin": "wf" }),
        data: { state: "rejected_timedout" },
      }),
    );
    const found = timedOut.data.promises.find((p: any) => p.id === "wf.step");
    expect(found).toBeDefined();
    expect(found.state).toBe("rejected_timedout");
  });
});
