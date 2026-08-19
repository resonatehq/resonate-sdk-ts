/**
 * Tests for the network/sources split (port of resonate-sdk-py PR #465):
 *
 * - resolution rules: url > network > RESONATE_URL env > local
 * - a dual-role connection passed as `network` doubles as the sole source
 * - explicit `sources` are used as-is; `sources[0]` is the primary source
 * - fail-fast guards: send-only network without sources, sources without a
 *   network, empty sources, and protocol violations (TypeError naming the
 *   missing members)
 * - lifecycle: identity-deduplicated start/stop; sources stop before network
 * - end-to-end: an execute delivered on a *secondary* source drives the
 *   engine to fulfillment over a real LocalConnection
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Message, Network, Request, Response, Source } from "@resonatehq/base";
import { HttpConnection } from "../../src/connections/http.js";
import { LocalConnection } from "../../src/connections/local.js";
import { resolveConnections, uniqueConnections } from "../../src/connections/resolve.js";
import { SseConnection } from "../../src/connections/sse.js";
import type { Context } from "../../src/context.js";
import { Resonate } from "../../src/resonate.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A push-only source that records lifecycle calls and delivered callbacks. */
class FakeSource implements Source {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  started = 0;
  stopped = 0;
  callbacks: Array<(msg: Message) => void> = [];

  constructor(pid = "fake-pid", group = "fake-group") {
    this.pid = pid;
    this.group = group;
    this.unicast = `fake://uni@${group}/${pid}`;
    this.anycast = `fake://any@${group}/${pid}`;
  }

  match(target: string): string {
    return `fake://any@${target}`;
  }

  recv(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }

  async start(): Promise<void> {
    this.started++;
  }

  async stop(): Promise<void> {
    this.stopped++;
  }
}

/** A send-only network (no source half) that records lifecycle calls. */
class SendOnlyNetwork implements Network {
  started = 0;
  stopped = 0;

  send = async <K extends Request["kind"]>(
    _req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    throw new Error("not implemented");
  };

  async start(): Promise<void> {
    this.started++;
  }

  async stop(): Promise<void> {
    this.stopped++;
  }
}

/** A LocalConnection that counts start/stop, to observe lifecycle dedup. */
class CountingLocal extends LocalConnection {
  startCount = 0;
  stopCount = 0;
  stopLog: string[];

  constructor(stopLog: string[] = [], opts: { pid?: string; group?: string } = {}) {
    super(opts);
    this.stopLog = stopLog;
  }

  override async start(): Promise<void> {
    this.startCount++;
    return super.start();
  }

  override async stop(): Promise<void> {
    this.stopCount++;
    this.stopLog.push("local");
    return super.stop();
  }
}

const basePid = { group: "default", pid: "test-pid" };

// ---------------------------------------------------------------------------
// resolveConnections
// ---------------------------------------------------------------------------

describe("resolveConnections", () => {
  afterEach(() => {
    delete process.env.RESONATE_URL;
  });

  test("defaults to a single LocalConnection as both network and sole source", () => {
    const { network, sources, local } = resolveConnections({ ...basePid });
    expect(local).toBe(true);
    expect(network).toBeInstanceOf(LocalConnection);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBe(network);
    expect(sources[0].pid).toBe("test-pid");
  });

  test("url resolves to HttpConnection + [SseConnection]", () => {
    const { network, sources, local } = resolveConnections({ ...basePid, url: "http://localhost:8001" });
    expect(local).toBe(false);
    expect(network).toBeInstanceOf(HttpConnection);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(SseConnection);
    expect(sources[0].pid).toBe("test-pid");
    expect(sources[0].group).toBe("default");
  });

  test("url wins over an explicit network", () => {
    const dual = new LocalConnection(basePid);
    const { network } = resolveConnections({ ...basePid, url: "http://localhost:8001", network: dual });
    expect(network).toBeInstanceOf(HttpConnection);
  });

  test("an explicit network wins over the RESONATE_URL env var", () => {
    process.env.RESONATE_URL = "http://localhost:8001";
    const dual = new LocalConnection(basePid);
    const { network, sources } = resolveConnections({ ...basePid, network: dual });
    expect(network).toBe(dual);
    expect(sources[0]).toBe(dual);
  });

  test("RESONATE_URL env resolves to HttpConnection + [SseConnection]", () => {
    process.env.RESONATE_URL = "http://localhost:8001";
    const { network, sources } = resolveConnections({ ...basePid });
    expect(network).toBeInstanceOf(HttpConnection);
    expect(sources[0]).toBeInstanceOf(SseConnection);
  });

  test("a dual-role network without sources doubles as the sole source", () => {
    const dual = new LocalConnection(basePid);
    const { network, sources } = resolveConnections({ ...basePid, network: dual });
    expect(network).toBe(dual);
    expect(sources).toEqual([dual]);
  });

  test("explicit sources are used as-is; a dual-role network's source half is not added", () => {
    const dual = new LocalConnection(basePid);
    const extra = new FakeSource();
    const { network, sources } = resolveConnections({ ...basePid, network: dual, sources: [extra] });
    expect(network).toBe(dual);
    expect(sources).toEqual([extra]);
  });

  test("a send-only network without sources throws", () => {
    expect(() => resolveConnections({ ...basePid, network: new SendOnlyNetwork() })).toThrow(/send-only/);
  });

  test("sources without a network throw", () => {
    expect(() => resolveConnections({ ...basePid, sources: [new FakeSource()] })).toThrow(/require a network/);
  });

  test("empty sources throw", () => {
    const dual = new LocalConnection(basePid);
    expect(() => resolveConnections({ ...basePid, network: dual, sources: [] })).toThrow(/must not be empty/);
  });

  test("an object missing Network members throws a TypeError naming them", () => {
    expect(() => resolveConnections({ ...basePid, network: { start: async () => {} } as any })).toThrow(TypeError);
    expect(() => resolveConnections({ ...basePid, network: { start: async () => {} } as any })).toThrow(
      /missing: send\(\), stop\(\)/,
    );
  });

  test("an object missing Source members throws a TypeError naming them", () => {
    const dual = new LocalConnection(basePid);
    const notASource = { recv: () => {}, start: async () => {}, stop: async () => {} };
    expect(() => resolveConnections({ ...basePid, network: dual, sources: [notASource as any] })).toThrow(TypeError);
    expect(() => resolveConnections({ ...basePid, network: dual, sources: [notASource as any] })).toThrow(
      /sources\[0\].*missing: match\(\), pid, group, unicast, anycast/,
    );
  });
});

// ---------------------------------------------------------------------------
// uniqueConnections
// ---------------------------------------------------------------------------

describe("uniqueConnections", () => {
  test("dedups by identity, preserving first-seen order", () => {
    const dual = new LocalConnection(basePid);
    const extra = new FakeSource();
    expect(uniqueConnections([dual, dual, extra])).toEqual([dual, extra]);
    expect(uniqueConnections([extra, dual, extra])).toEqual([extra, dual]);
  });
});

// ---------------------------------------------------------------------------
// Resonate wiring
// ---------------------------------------------------------------------------

describe("Resonate <-> connections wiring", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("a dual-role connection passed as network starts and stops exactly once", async () => {
    const dual = new CountingLocal([], basePid);
    const resonate = new Resonate({ network: dual, ttl: 60_000 });
    // start() is fired (not awaited) from the constructor
    await new Promise((r) => setTimeout(r, 0));
    expect(dual.startCount).toBe(1);
    await resonate.stop();
    expect(dual.stopCount).toBe(1);
  });

  test("every source is subscribed and started; sources stop before the network", async () => {
    const stopLog: string[] = [];
    const dual = new CountingLocal(stopLog, basePid);
    const extra = new FakeSource();
    const originalStop = extra.stop.bind(extra);
    extra.stop = async () => {
      stopLog.push("extra");
      await originalStop();
    };

    const resonate = new Resonate({ network: dual, sources: [dual, extra], ttl: 60_000 });
    await new Promise((r) => setTimeout(r, 0));

    expect(dual.startCount).toBe(1);
    expect(extra.started).toBe(1);
    // both sources got the engine's recv callback
    expect(extra.callbacks).toHaveLength(1);

    await resonate.stop();
    expect(dual.stopCount).toBe(1);
    expect(extra.stopped).toBe(1);
    // sources stop in order before the (deduped) network half; the dual
    // connection is sources[0], so it stops first, then extra.
    expect(stopLog).toEqual(["local", "extra"]);
  });

  test("primary source identity: pid, unicast, and anycast come from sources[0]", async () => {
    const local = new LocalConnection(basePid);
    const primary = new FakeSource("primary-pid", "primary-group");

    const sent: any[] = [];
    const originalSend = local.send;
    local.send = ((req: any) => {
      sent.push(req);
      return originalSend(req);
    }) as typeof local.send;

    const resonate = new Resonate({ network: local, sources: [primary, local], ttl: 60_000 });
    resonate.register("f", function* (_ctx: Context): Generator<any, string, any> {
      return "ok";
    });

    const handle = await resonate.beginRun("wiring-primary", "f");
    expect(await handle.result()).toBe("ok");

    const taskCreate = sent.find((r) => r.kind === "task.create");
    expect(taskCreate.data.pid).toBe("primary-pid");
    expect(taskCreate.data.action.data.tags["resonate:target"]).toBe(primary.anycast);

    const listener = sent.find((r) => r.kind === "promise.register_listener");
    expect(listener.data.address).toBe(primary.unicast);

    await resonate.stop();
  });

  test("an execute delivered on a secondary source drives the engine to fulfillment", async () => {
    // The primary source is inert (identity only); all push traffic — the
    // execute that runs the task and the unblock that settles the handle —
    // arrives via the LocalConnection registered as a *secondary* source.
    const local = new LocalConnection(basePid);
    const primary = new FakeSource();

    const resonate = new Resonate({ network: local, sources: [primary, local], ttl: 60_000 });
    resonate.register("g", function* (_ctx: Context, n: number): Generator<any, number, any> {
      return n * 2;
    });

    expect(await resonate.run("wiring-secondary", "g", 21)).toBe(42);
    await resonate.stop();
  });
});
