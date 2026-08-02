import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { originOf, TursoNetwork, tursoLocalDriver } from "../src/network/turso/index.js";
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

    box.messages.length = 0;
    await net.send({
      kind: "promise.settle",
      head: head(),
      data: { id: "wf.child", state: "resolved", value: { data: "child" } },
    });

    const msg = await box.next((m) => m.kind === "execute");
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

  test("a second process picks up work it never created", async () => {
    // The whole point of the tenant-global database: a worker that has never
    // heard of this workflow finds it through the message index, opens the
    // origin database the id names, and claims the task.
    const dir = mkdtempSync(join(tmpdir(), "resonate-turso-"));
    const creator = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "shared-",
      group: "creators",
      tickMs: 5,
    });
    const worker = new TursoNetwork({
      driver: tursoLocalDriver({ dir }),
      prefix: "shared-",
      group: "workers",
      tickMs: 5,
    });
    try {
      await creator.init();
      await worker.init();
      const box = inbox(worker);

      // Targeted at the worker group, so only the worker may claim it.
      ok(
        await creator.send({
          kind: "promise.create",
          head: head(),
          data: {
            id: "handoff",
            timeoutAt: Date.now() + 60_000,
            param: { data: "payload" },
            tags: { "resonate:target": creator.match("workers") },
          },
        }),
      );

      const msg = await box.next((m) => m.kind === "execute");
      expect(msg).toEqual({ kind: "execute", head: {}, data: { task: { id: "handoff", version: 0 } } });

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
