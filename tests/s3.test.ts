import { afterEach, describe, expect, test } from "@jest/globals";
import { type Context as AsyncContext, Resonate as AsyncResonate } from "../src/async/index.js";
import { type Context, Resonate } from "../src/index.js";
import {
  hashOrigin,
  MemoryBucket,
  minuteBucket,
  originOf,
  ownerOf,
  parseEntryKey,
  S3Network,
  workflowKey,
} from "../src/network/s3/index.js";
import type { Message, Request, Response } from "../src/network/types.js";
import { VERSION } from "../src/util.js";

// Every test drives the network directly, so the request head is boilerplate.
let corr = 0;
function head(extra: Record<string, unknown> = {}) {
  corr += 1;
  return { corrId: `c${corr}`, version: VERSION, ...extra } as Request["head"];
}

const TARGET = "poll://any@default";

/** A fresh pair of in-memory buckets — one fleet's worth of shared storage. */
function buckets() {
  return { workflows: new MemoryBucket(), timeouts: new MemoryBucket() };
}

function network(overrides: Record<string, unknown> = {}) {
  return new S3Network({
    ...buckets(),
    tickMs: 5,
    retryTimeout: 1000,
    ...overrides,
  });
}

const open: S3Network[] = [];
function tracked(overrides: Record<string, unknown> = {}): S3Network {
  const net = network(overrides);
  open.push(net);
  return net;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.stop();
});

/** Collect messages the network delivers, so tests can await a specific one. */
function inbox(net: S3Network) {
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
  // nodes running the Turso network or the Python SDK, which assert the same
  // vector — so a change that quietly reshuffles ownership has to fail here
  // first.
  test("matches the fixed vector shared with the other SDKs", () => {
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
// TIME BUCKETS
// =============================================================================

describe("time buckets", () => {
  test("minute buckets are UTC, minute-precision, and lexicographically chronological", () => {
    expect(minuteBucket(Date.UTC(2026, 7, 8, 12, 34, 56, 789))).toBe("2026-08-08T12:34");
    expect(minuteBucket(Date.UTC(2026, 7, 8, 12, 34))).toBe("2026-08-08T12:34");
    const times = [
      Date.UTC(2025, 11, 31, 23, 59),
      Date.UTC(2026, 0, 1, 0, 0),
      Date.UTC(2026, 0, 1, 0, 1),
      Date.UTC(2026, 8, 30, 4, 5),
    ];
    const bucketed = times.map(minuteBucket);
    expect([...bucketed].sort()).toEqual(bucketed);
  });

  test("entry keys round-trip through the parser, escaping what needs escaping", () => {
    const at = Date.UTC(2026, 7, 8, 9, 10, 11);
    for (const [key, kind, name] of [
      [`t/${minuteBucket(at)}/o/wf-1`, "origin", "wf-1"],
      [`t/${minuteBucket(at)}/s/nightly`, "schedule", "nightly"],
      [`t/${minuteBucket(at)}/o/${encodeURIComponent("weird/na me")}`, "origin", "weird/na me"],
    ] as const) {
      const parsed = parseEntryKey(key);
      expect(parsed).not.toBeNull();
      expect(parsed?.kind).toBe(kind);
      expect(parsed?.name).toBe(name);
      expect(parsed?.bucket).toBe(minuteBucket(at));
    }
    expect(parseEntryKey("sched/nightly")).toBeNull();
    expect(parseEntryKey("t/garbage")).toBeNull();
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
// STORAGE SHAPE: ONE WORKFLOW = ONE DOCUMENT, ONE TIMEOUT = ONE DOCUMENT
// =============================================================================

describe("storage shape", () => {
  test("each origin gets exactly one document in the workflow bucket", async () => {
    const shared = buckets();
    const net = tracked({ ...shared, tickMs: 60_000 });
    await net.init();
    const timeoutAt = Date.now() + 60_000;

    for (const id of ["alpha", "beta.1", "beta.2"]) {
      ok(
        await net.send({
          kind: "promise.create",
          head: head(),
          data: { id, timeoutAt, param: {}, tags: {} },
        }),
      );
    }

    expect(shared.workflows.keys()).toEqual([workflowKey("alpha"), workflowKey("beta")]);
  });

  test("arming a timer writes one wakeup document, keyed by its time bucket, before the workflow lands", async () => {
    const shared = buckets();
    const net = tracked({ ...shared, tickMs: 60_000, retryTimeout: 1000 });
    await net.init();
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: { id: "wf", timeoutAt: now + 60_000, param: {}, tags: { "resonate:target": TARGET } },
    });

    // The earliest armed deadline is the retry timer at now + 1000; the entry
    // sits in that instant's minute bucket, one document per wakeup.
    const entries = shared.timeouts.keys().filter((k) => k.startsWith("t/"));
    expect(entries).toEqual([`t/${minuteBucket(now + 1000)}/o/wf`]);
  });

  test("a fired entry is completed: fire then delete, and the next deadline has its own cover", async () => {
    const shared = buckets();
    const net = tracked({ ...shared, tickMs: 60_000, retryTimeout: 120_000 });
    await net.init();
    const box = inbox(net);
    const now = Date.now();

    await net.send({
      kind: "promise.create",
      head: head({ "resonate:debug_time": now }),
      data: { id: "wf", timeoutAt: now + 300_000, param: {}, tags: { "resonate:target": TARGET } },
    });
    await box.next((m) => m.kind === "execute");
    const before = shared.timeouts.keys().filter((k) => k.startsWith("t/"));
    expect(before).toEqual([`t/${minuteBucket(now + 120_000)}/o/wf`]);

    // The retry comes due; the sweep redispatches and re-arms at a later
    // minute, so the old entry is consumed and the new deadline gets its own.
    await net.send({ kind: "debug.tick", head: head(), data: { time: now + 150_000 } });
    const after = shared.timeouts.keys().filter((k) => k.startsWith("t/"));
    expect(after).toEqual([`t/${minuteBucket(now + 270_000)}/o/wf`]);
  });

  test("a stale entry is swept away after re-validation, not trusted", async () => {
    const shared = buckets();
    const net = tracked({ ...shared, tickMs: 60_000 });
    await net.init();
    const now = Date.now();

    // An entry for an origin with no document at all — a crashed writer's
    // leftover. The sweep opens the origin, finds nothing due, and deletes it.
    await shared.timeouts.put(`t/${minuteBucket(now - 60_000)}/o/ghost`, JSON.stringify({ at: now - 60_000 }), {
      kind: "create",
    });
    await net.send({ kind: "debug.tick", head: head(), data: { time: now } });

    expect(shared.timeouts.keys().filter((k) => k.startsWith("t/"))).toEqual([]);
    // And no phantom document was created by looking.
    expect(shared.workflows.keys()).toEqual([]);
  });

  test("two processes racing the same acquire produce exactly one winner", async () => {
    const shared = buckets();
    const a = tracked({ ...shared, tickMs: 60_000 });
    const b = tracked({ ...shared, tickMs: 60_000 });
    await a.init();
    await b.init();

    ok(
      await a.send({
        kind: "promise.create",
        head: head(),
        data: { id: "wf", timeoutAt: Date.now() + 60_000, param: {}, tags: { "resonate:target": TARGET } },
      }),
    );

    // Both processes race the same version through the same bucket. The
    // conditional PUT is the only arbiter: exactly one may win.
    const [ra, rb] = await Promise.all([
      a.send({ kind: "task.acquire", head: head(), data: { id: "wf", version: 0, pid: "pa", ttl: 30_000 } }),
      b.send({ kind: "task.acquire", head: head(), data: { id: "wf", version: 0, pid: "pb", ttl: 30_000 } }),
    ]);
    const statuses = [ra.head.status, rb.head.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  test("a message reaches the client without any storage backing it", async () => {
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
    // past the life of this test, so nothing but the landed write could have
    // done it.
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
});

// =============================================================================
// PARTITIONING AND THE FLEET
// =============================================================================

describe("partitioning", () => {
  test("a second process picks up work it never created, through the timeout bucket", async () => {
    // This is the whole recovery story now that messages are not queued. The
    // creator delivers the execute to itself and does nothing with it. The
    // task stays pending, its retry timer comes due, and the worker — which
    // has never heard of this workflow — finds its wakeup entry in the
    // timeout bucket, reads the origin document the entry names, and gets the
    // execute delivered locally.
    const shared = buckets();
    const creator = tracked({ ...shared, tickMs: 60_000, retryTimeout: 100 });
    const worker = tracked({ ...shared, tickMs: 5, retryTimeout: 100 });
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

    // The worker reads the origin document for the first time and claims it.
    const acquired = ok(
      await worker.send({
        kind: "task.acquire",
        head: head(),
        data: { id: "handoff", version: 0, pid: "worker-1", ttl: 30_000 },
      }),
    );
    expect(acquired.data.promise.param.data).toBe("payload");

    // And the creator sees the claim, because both read the same document.
    const seen = ok(await creator.send({ kind: "task.get", head: head(), data: { id: "handoff" } }));
    expect(seen.data.task.state).toBe("acquired");
    expect(seen.data.task.pid).toBe("worker-1");
  });

  test("a sharded node sweeps only the wakeups of the origins it owns", async () => {
    // The point of `shard`. Both slices sit in one timeout bucket; a node
    // must act on its own and leave the other's alone, or two nodes end up
    // driving one workflow.
    const shared = buckets();
    const ids = ["alpha", "beta", "gamma", "delta"];
    const mine = ids.filter((id) => ownerOf(id, 2) === 0);
    const theirs = ids.filter((id) => ownerOf(id, 2) === 1);
    // A useless test if the hash happens to send everything one way.
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);

    // Creates the work but never sweeps, so every execute below is swept.
    const creator = tracked({ ...shared, tickMs: 60_000, retryTimeout: 50 });
    const node0 = tracked({ ...shared, tickMs: 5, retryTimeout: 50, shard: { index: 0, count: 2 } });
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
    // The search is scoped to the alpha document, which holds only alpha's ids.
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
// against two buckets with no server anywhere.

describe("end to end", () => {
  test("a generator workflow runs to completion and can be re-attached to", async () => {
    const shared = buckets();
    const resonate = new Resonate({ network: new S3Network({ ...shared, tickMs: 20 }) });
    resonate.register("order", function* (ctx: Context, customer: string, amount: number): any {
      const ref = yield* ctx.run(async () => `CH-${amount}`);
      yield* ctx.sleep(30);
      return `${customer}:${ref}`;
    });

    let other: Resonate | undefined;
    try {
      expect(await resonate.run("order-1", "order", "acme", 100)).toBe("acme:CH-100");

      // A second client over the same buckets sees the settled result.
      other = new Resonate({ network: new S3Network({ ...shared, tickMs: 20 }) });
      expect(await (await other.get("order-1")).result()).toBe("acme:CH-100");
    } finally {
      await other?.stop();
      await resonate.stop();
    }
  }, 30_000);

  test("a workflow abandoned mid-flight is finished by another process", async () => {
    // The recovery claim, end to end: A dies while its workflow is asleep, and
    // B — which has never seen this workflow — picks it up off the timeout
    // bucket and runs it to completion.
    const shared = buckets();
    const worker = (pid: string) => {
      const r = new Resonate({
        pid,
        network: new S3Network({ ...shared, pid, tickMs: 20, retryTimeout: 300 }),
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
    }
  }, 30_000);

  test("an async-engine workflow runs to completion", async () => {
    const resonate = new AsyncResonate({ network: new S3Network({ ...buckets(), tickMs: 20 }) });
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
    }
  }, 30_000);
});

// =============================================================================
// DECLARED ORIGIN HEADER
// =============================================================================

describe("declared origin header", () => {
  test("a header carrying a full id is normalized to its origin", async () => {
    // The engine cores stamp resonate:origin with the full task id, not its
    // origin; routing must normalize it, or a dotted id becomes the name of a
    // phantom document and every such acquire answers 404.
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
    // document — the one thing the partition must never do.
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
