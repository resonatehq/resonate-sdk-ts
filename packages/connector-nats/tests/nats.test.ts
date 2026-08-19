import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { isSuccess, type Message, type Request, ResonateTimeoutException } from "@resonatehq/base";
import { NatsConnection } from "../src/index.js";

// The protocol version stamped into request heads; the fake server echoes it.
const VERSION = "2026-04-01";

// =============================================================================
// In-memory fake NatsConnection
// =============================================================================
//
// Models just enough of `@nats-io/transport-node`'s NatsConnection for the
// NatsConnection port: subject-token routing (with `*`/`>` wildcards), queue
// groups (deliver once per group), publish headers, `max`-auto-unsubscribe,
// and subscription timeouts firing the callback with an error.

type MsgCb = (err: Error | null, msg: any) => void;

interface FakeSub {
  subject: string;
  queue?: string;
  callback?: MsgCb;
  max?: number;
  count: number;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

function subjectMatch(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return true; // matches the rest
    if (i >= s.length) return false;
    if (p[i] === "*") continue; // matches a single token
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

function makeMsg(subject: string, payload: string | Uint8Array, headers?: any) {
  const str = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  return {
    subject,
    headers,
    data: new TextEncoder().encode(str),
    string: () => str,
  };
}

class FakeNats {
  subs: FakeSub[] = [];
  published: Array<{ subject: string; payload: string; headers?: any }> = [];

  subscribe(subject: string, opts: any = {}) {
    const sub: FakeSub = {
      subject,
      queue: opts.queue,
      callback: opts.callback,
      max: opts.max,
      count: 0,
      closed: false,
    };
    if (opts.timeout) {
      sub.timer = setTimeout(() => {
        if (sub.closed) return;
        sub.closed = true;
        sub.callback?.(new Error("TIMEOUT"), {});
      }, opts.timeout);
    }
    this.subs.push(sub);
    return {
      unsubscribe: () => {
        sub.closed = true;
        if (sub.timer) clearTimeout(sub.timer);
      },
    };
  }

  publish(subject: string, payload: string | Uint8Array, opts: any = {}) {
    const str = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    this.published.push({ subject, payload: str, headers: opts.headers });

    const msg = makeMsg(subject, payload, opts.headers);
    const deliveredQueues = new Set<string>();
    // Snapshot to avoid mutation surprises when a callback publishes.
    for (const sub of [...this.subs]) {
      if (sub.closed || !subjectMatch(sub.subject, subject)) continue;
      if (sub.queue) {
        if (deliveredQueues.has(sub.queue)) continue;
        deliveredQueues.add(sub.queue);
      }
      if (sub.timer) {
        clearTimeout(sub.timer);
        sub.timer = undefined;
      }
      sub.count++;
      sub.callback?.(null, msg);
      if (sub.max !== undefined && sub.count >= sub.max) sub.closed = true;
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function promiseGetReq(id: string, corrId = "corr-1"): Extract<Request, { kind: "promise.get" }> {
  return { kind: "promise.get", head: { corrId, version: VERSION }, data: { id } };
}

function promiseGetOkReply(id: string, corrId: string): string {
  return JSON.stringify({
    kind: "promise.get",
    head: { corrId, status: 200, version: VERSION },
    data: {
      promise: {
        id,
        state: "pending",
        param: {},
        value: {},
        tags: {},
        timeoutAt: 1,
        createdAt: 1,
      },
    },
  });
}

const REPLY_HEADER = "Resonate-Reply-To";

// Wire the fake so publishes to the request prefix are answered on the inbox
// named in the Resonate-Reply-To header.
function attachServer(fake: FakeNats, respond: (envelope: any, corrId: string) => string): void {
  fake.subscribe("resonate.requests.>", {
    callback: (_err: Error | null, msg: any) => {
      const envelope = JSON.parse(msg.string());
      const inbox = msg.headers?.get(REPLY_HEADER);
      const corrId = envelope.head.corrId;
      fake.publish(inbox, respond(envelope, corrId));
    },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("NatsConnection addresses & match", () => {
  test("derives unicast/anycast subjects and match address", () => {
    const net = new NatsConnection({ conn: new FakeNats() as any, pid: "p1", group: "g1" });
    expect(net.unicast).toBe("nats://resonate.recv.g1.p1");
    expect(net.anycast).toBe("nats://resonate.recv.g1");
    expect(net.match("workerpool")).toBe("nats://resonate.recv.workerpool");
  });

  test("honors custom worker topic", () => {
    const net = new NatsConnection({ conn: new FakeNats() as any, pid: "p1", group: "g1", workerTopic: "custom.recv" });
    expect(net.unicast).toBe("nats://custom.recv.g1.p1");
    expect(net.match("t")).toBe("nats://custom.recv.t");
  });
});

describe("NatsConnection.send()", () => {
  let fake: FakeNats;
  let net: NatsConnection;

  beforeEach(() => {
    fake = new FakeNats();
  });

  afterEach(async () => {
    if (net) await net.stop();
  });

  test("round-trips a request and returns the typed response", async () => {
    attachServer(fake, (_env, corrId) => promiseGetOkReply("p1", corrId));
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    await net.start();

    const res = await net.send(promiseGetReq("p1", "corr-abc"));
    expect(res.kind).toBe("promise.get");
    expect(res.head.corrId).toBe("corr-abc");
    expect(res.head.status).toBe(200);
    if (isSuccess(res)) {
      expect(res.data.promise.id).toBe("p1");
    }
  });

  test("publishes to the base64url(origin) subject and injects resonate:origin", async () => {
    let seen: any;
    attachServer(fake, (env, corrId) => {
      seen = env;
      return promiseGetOkReply("foo", corrId);
    });
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    await net.start();

    // origin is the lineage root: substring before the first colon of the id.
    await net.send(promiseGetReq("foo:bar.baz", "c1"));

    const token = Buffer.from("foo", "utf8").toString("base64url");
    const reqPublish = fake.published.find((p) => p.subject.startsWith("resonate.requests."));
    expect(reqPublish?.subject).toBe(`resonate.requests.${token}`);
    expect(seen.head["resonate:origin"]).toBe("foo");
    expect(reqPublish?.headers?.get(REPLY_HEADER)).toMatch(/^_INBOX\./);
  });

  test("routing origin for task.create uses the nested action id", async () => {
    let seen: any;
    attachServer(fake, (env, corrId) => {
      seen = env;
      return JSON.stringify({
        kind: "task.create",
        head: { corrId, status: 200, version: VERSION },
        data: {
          promise: { id: "root", state: "pending", param: {}, value: {}, tags: {}, timeoutAt: 1, createdAt: 1 },
          preload: [],
        },
      });
    });
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    await net.start();

    const req: Extract<Request, { kind: "task.create" }> = {
      kind: "task.create",
      head: { corrId: "c1", version: VERSION },
      data: {
        pid: "p1",
        ttl: 1000,
        action: {
          kind: "promise.create",
          head: { corrId: "c1", version: VERSION },
          data: { id: "root:child.1", timeoutAt: 1, param: {}, tags: {} },
        },
      },
    };
    await net.send(req);
    expect(seen.head["resonate:origin"]).toBe("root");
  });

  test("times out into a ResonateTimeoutException when no reply arrives", async () => {
    // No server attached — the inbox subscription's timeout fires.
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1", requestTimeout: 20 });
    await net.start();
    await expect(net.send(promiseGetReq("p1"))).rejects.toBeInstanceOf(ResonateTimeoutException);
  });

  test("rejects a reply whose corrId does not match the request", async () => {
    attachServer(fake, (_env, _corrId) => promiseGetOkReply("p1", "different-corr"));
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    await net.start();
    await expect(net.send(promiseGetReq("p1", "corr-x"))).rejects.toBeInstanceOf(ResonateTimeoutException);
  });

  test("rejects a malformed JSON reply", async () => {
    attachServer(fake, () => "not json{");
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    await net.start();
    await expect(net.send(promiseGetReq("p1"))).rejects.toBeInstanceOf(ResonateTimeoutException);
  });

  test("a send issued before init resolves completes once init runs", async () => {
    attachServer(fake, (_e, corrId) => promiseGetOkReply("p1", corrId));
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    // Fire the send before init() — it must wait for readiness, not throw.
    const pending = net.send(promiseGetReq("p1", "corr-early"));
    await net.start();
    const res = await pending;
    expect(res.head.corrId).toBe("corr-early");
  });

  test("throws when sending after stop", async () => {
    attachServer(fake, (_e, corrId) => promiseGetOkReply("p1", corrId));
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    await net.start();
    await net.stop();
    await expect(net.send(promiseGetReq("p1"))).rejects.toBeInstanceOf(ResonateTimeoutException);
  });
});

describe("NatsConnection.recv()", () => {
  let fake: FakeNats;
  let net: NatsConnection;

  beforeEach(() => {
    fake = new FakeNats();
  });

  afterEach(async () => {
    if (net) await net.stop();
  });

  test("delivers an execute message published on the unicast subject", async () => {
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    const received: Message[] = [];
    net.recv((m) => received.push(m));
    await net.start();

    const execute = JSON.stringify({ kind: "execute", head: {}, data: { task: { id: "t1", version: 0 } } });
    fake.publish("resonate.recv.g1.p1", execute);

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("execute");
    if (received[0].kind === "execute") {
      expect(received[0].data.task.id).toBe("t1");
    }
  });

  test("delivers an anycast message once across the queue group", async () => {
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    const received: Message[] = [];
    net.recv((m) => received.push(m));
    await net.start();

    const unblock = JSON.stringify({
      kind: "unblock",
      head: {},
      data: {
        promise: { id: "p9", state: "resolved", param: {}, value: {}, tags: {}, timeoutAt: 1, createdAt: 1 },
      },
    });
    fake.publish("resonate.recv.g1", unblock);

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("unblock");
  });

  test("drops malformed messages without invoking the callback", async () => {
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    const received: Message[] = [];
    net.recv((m) => received.push(m));
    await net.start();

    fake.publish("resonate.recv.g1.p1", "not json{");
    fake.publish("resonate.recv.g1.p1", JSON.stringify({ kind: "bogus" }));

    expect(received).toHaveLength(0);
  });

  test("stops delivering after stop()", async () => {
    net = new NatsConnection({ conn: fake as any, pid: "p1", group: "g1" });
    const received: Message[] = [];
    net.recv((m) => received.push(m));
    await net.start();
    await net.stop();

    const execute = JSON.stringify({ kind: "execute", head: {}, data: { task: { id: "t1", version: 0 } } });
    fake.publish("resonate.recv.g1.p1", execute);
    expect(received).toHaveLength(0);
  });
});
