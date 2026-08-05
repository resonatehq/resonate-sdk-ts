import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import type { Context } from "../../src/context.js";
import { DurableNetwork } from "../../src/network/durable.js";
import { JetStreamLog } from "../../src/network/server/jetstream.js";
import { ConflictError } from "../../src/network/server/log.js";
import {
  isWrongLastSequence,
  jetStreamLogBinding,
  jetStreamTimerBinding,
  resonateStreamConfig,
} from "../../src/network/server/nats-binding.js";
import { JetStreamTimerService, originFromScheduler, SCHEDULER_HEADER } from "../../src/network/server/nats-timer.js";
import { CollectingTransport, OriginRuntime } from "../../src/network/server/runtime.js";
import { snapshot } from "../../src/network/server/state.js";
import { isSuccess, type Request } from "../../src/network/types.js";
import { Resonate } from "../../src/resonate.js";
import { VERSION } from "../../src/util.js";

// =============================================================================
// LIVE NATS INTEGRATION
// =============================================================================
//
// Runs against a real nats-server (2.12+ for `@at` schedules). Skipped unless
// RESONATE_NATS_URL is set, so the default suite stays hermetic:
//
//   nats-server -js -sd /tmp/natsjs -p 4222
//   RESONATE_NATS_URL=127.0.0.1:4222 npx jest tests/network/nats-integration
//
// This is the only place the client bindings are exercised. Everything else is
// tested against fakes, and a fake cannot tell us whether the broker actually
// behaves the way the design assumes.

const URL = process.env.RESONATE_NATS_URL;
const d = URL ? describe : describe.skip;

const STREAM = "RESONATE_TEST";
const LOG_PREFIX = "rt.log";
const TIMER_PREFIX = "rt.timers";
const TICK_PREFIX = "rt.ticks";

const head = () => ({ corrId: "c", version: VERSION });
const TARGET = "local://any@default";

function createReq(id: string, timeoutAt: number, tags: Record<string, string> = {}): Request {
  return { kind: "promise.create", head: head(), data: { id, timeoutAt, param: {}, tags } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("live NATS", () => {
  let nc: Awaited<ReturnType<typeof connect>>;
  let jsm: any;
  let js: any;

  beforeAll(async () => {
    nc = await connect({ servers: URL! });
    jsm = await jetstreamManager(nc);
    js = jetstream(nc);
  });

  afterAll(async () => {
    await nc?.close();
  });

  // Each test gets a pristine stream, so nothing leaks between them.
  async function freshStream() {
    try {
      await jsm.streams.delete(STREAM);
    } catch {
      /* absent */
    }
    await jsm.streams.add(resonateStreamConfig(STREAM, LOG_PREFIX, TIMER_PREFIX, TICK_PREFIX));
  }

  function makeLog() {
    return new JetStreamLog(jetStreamLogBinding(js, jsm, STREAM), LOG_PREFIX);
  }

  function makeTimers() {
    return new JetStreamTimerService({
      binding: jetStreamTimerBinding(js, jsm, STREAM),
      timerPrefix: TIMER_PREFIX,
      tickPrefix: TICK_PREFIX,
    });
  }

  describe("origin log", () => {
    beforeAll(freshStream);

    test("appends, reads back, and enumerates origins", async () => {
      const log = makeLog();
      const seq = await log.append("root", [{ kind: "outbox.clear" }], 0);
      expect(seq).toBeGreaterThan(0);

      const entries = await log.read("root", 0);
      expect(entries).toHaveLength(1);
      expect(entries[0].changes).toEqual([{ kind: "outbox.clear" }]);
      expect(await log.origins()).toContain("root");
    });

    test("a stale expectation is rejected as a conflict by the real server", async () => {
      const log = makeLog();
      const seq = await log.append("conflict", [{ kind: "outbox.clear" }], 0);

      // This is the assumption the whole concurrency story rests on, and the
      // one a fake cannot validate.
      await expect(log.append("conflict", [{ kind: "outbox.clear" }], 0)).rejects.toThrow(ConflictError);
      await expect(log.append("conflict", [{ kind: "outbox.clear" }], seq)).resolves.toBeGreaterThan(seq);
    });

    test("the conflict error is recognised by code, not only message", async () => {
      try {
        await js.publish(`${LOG_PREFIX}.probe`, new TextEncoder().encode("x"), {
          expect: { lastSubjectSequence: 999_999 },
        });
        throw new Error("expected the publish to be rejected");
      } catch (err) {
        expect(isWrongLastSequence(err)).toBe(true);
      }
    });

    test("origins with awkward characters round-trip through subject encoding", async () => {
      const log = makeLog();
      for (const origin of ["with.dots", "with/slash", "unicode-éè"]) {
        await log.append(origin, [{ kind: "outbox.clear" }], 0);
      }
      const origins = await log.origins();
      for (const origin of ["with.dots", "with/slash", "unicode-éè"]) {
        expect(origins).toContain(origin);
      }
    });

    test("trim reclaims history but keeps the origin enumerable", async () => {
      const log = makeLog();
      let seq = 0;
      for (let i = 0; i < 5; i++) seq = await log.append("trimmed", [{ kind: "outbox.clear" }], seq);

      await log.trim("trimmed", seq);

      // The bug this guards: an empty subject vanishes from state.subjects, and
      // an origin the runtime cannot enumerate is a dead lineage.
      expect(await log.origins()).toContain("trimmed");
      expect(await log.head("trimmed")).toBe(seq);
      await expect(log.append("trimmed", [{ kind: "outbox.clear" }], seq)).resolves.toBeGreaterThan(seq);
    });
  });

  describe("runtime over a real log", () => {
    beforeAll(freshStream);

    test("commits and rebuilds a lineage from durable state", async () => {
      const log = makeLog();
      const now = Date.now();
      const first = new OriginRuntime({ log, transport: new CollectingTransport() });

      await first.apply(now, createReq("root", now + 600_000, { "resonate:target": TARGET }));
      await first.apply(now, createReq("root.child", now + 600_000));

      // A separate runtime sharing only NATS.
      const second = new OriginRuntime({ log });
      const state = snapshot(await second.inspect("root"));
      expect(Object.keys(state.promises).sort()).toEqual(["root", "root.child"]);
      expect(state.tasks.root.state).toBe("pending");
    });

    test("concurrent runtimes over one stream lose no updates", async () => {
      const a = new OriginRuntime({ log: makeLog() });
      const b = new OriginRuntime({ log: makeLog() });
      const now = Date.now();

      for (let i = 0; i < 8; i++) {
        await a.apply(now, createReq(`race.a${i}`, now + 600_000));
        await b.apply(now, createReq(`race.b${i}`, now + 600_000));
      }

      const cold = new OriginRuntime({ log: makeLog() });
      expect(Object.keys(snapshot(await cold.inspect("race")).promises)).toHaveLength(16);
    });

    test("a suspend/resume cycle survives cold starts on every step", async () => {
      const log = makeLog();
      const now = Date.now();
      const transport = new CollectingTransport();
      const step = (req: Request) => new OriginRuntime({ log, transport }).apply(now, req);

      await step(createReq("wf", now + 600_000, { "resonate:target": TARGET, "resonate:branch": "wf" }));
      await step({ kind: "task.acquire", head: head(), data: { id: "wf", version: 0, pid: "p", ttl: 30_000 } });
      await step(createReq("wf.child", now + 600_000));
      await step({
        kind: "task.suspend",
        head: head(),
        data: {
          id: "wf",
          version: 1,
          actions: [{ kind: "promise.register_callback", head: head(), data: { awaited: "wf.child", awaiter: "wf" } }],
        },
      });

      const suspended = snapshot(await new OriginRuntime({ log }).inspect("wf"));
      expect(suspended.tasks.wf.state).toBe("suspended");
      // The awaiter edge crossed NATS and came back intact.
      expect(suspended.callbacks["wf.child"]).toEqual(["wf"]);

      await step({ kind: "promise.settle", head: head(), data: { id: "wf.child", state: "resolved", value: {} } });

      const resumed = snapshot(await new OriginRuntime({ log }).inspect("wf"));
      expect(resumed.tasks.wf.state).toBe("pending");
    });
  });

  describe("broker-scheduled timers", () => {
    beforeAll(freshStream);

    test("a schedule is stored and readable back", async () => {
      const timers = makeTimers();
      const at = Date.now() + 120_000;
      await timers.setDeadline("stored", at);

      timers.evict();
      const readBack = await timers.deadline("stored");
      // RFC3339 has second granularity, so allow rounding.
      expect(readBack).toBeDefined();
      expect(Math.abs(readBack! - at)).toBeLessThanOrEqual(1000);
    });

    test("armNoLaterThan never moves a deadline later, against the real store", async () => {
      const timers = makeTimers();
      const base = Date.now() + 120_000;
      await timers.setDeadline("monotone", base);

      // Drop the local cache so the guard has to consult the stream.
      timers.evict();
      await timers.armNoLaterThan("monotone", base + 60_000);
      timers.evict();
      expect(Math.abs((await timers.deadline("monotone"))! - base)).toBeLessThanOrEqual(1000);

      timers.evict();
      await timers.armNoLaterThan("monotone", base - 60_000);
      timers.evict();
      expect(Math.abs((await timers.deadline("monotone"))! - (base - 60_000))).toBeLessThanOrEqual(1000);
    });

    test("clearing a deadline cancels the schedule", async () => {
      const timers = makeTimers();
      await timers.setDeadline("cancelled", Date.now() + 120_000);
      await timers.setDeadline("cancelled", undefined);

      timers.evict();
      expect(await timers.deadline("cancelled")).toBeUndefined();
    });

    test("a schedule fires into the stream, naming its lineage", async () => {
      const timers = makeTimers();
      await timers.setDeadline("firing", Date.now() + 1500);

      await sleep(4000);

      // The fired message is durable stream state, not a wire message: with no
      // consumer running there is nothing to miss.
      const msg = await jsm.streams.getMessage(STREAM, { last_by_subj: timers.tickSubject("firing") });
      expect(msg).toBeTruthy();

      // The lineage is recoverable from the header the server stamps on.
      const scheduler = msg!.header?.get(SCHEDULER_HEADER);
      expect(scheduler).toBe(timers.timerSubject("firing"));
      expect(originFromScheduler(scheduler!, TIMER_PREFIX)).toBe("firing");
    }, 20_000);

    test("re-arming earlier makes it fire earlier", async () => {
      const timers = makeTimers();
      await timers.setDeadline("rearm", Date.now() + 3_600_000);
      // Re-arm far earlier; the publish must replace, not accumulate.
      await timers.setDeadline("rearm", Date.now() + 1500);

      await sleep(4000);
      const msg = await jsm.streams.getMessage(STREAM, { last_by_subj: timers.tickSubject("rearm") });
      expect(msg).toBeTruthy();
    }, 20_000);
  });

  describe("end to end", () => {
    beforeAll(freshStream);

    test("a promise deadline fires via the broker and settles the promise", async () => {
      // The full chain, with nothing polling: commit to the log, arm a broker
      // schedule, let nats-server fire it, consume the tick, run the machine's
      // timeout transition, commit the result.
      const log = makeLog();
      const timers = makeTimers();
      const runtime = new OriginRuntime({ log, timers, transport: new CollectingTransport() });

      const now = Date.now();
      await runtime.apply(now, createReq("expiry", now + 2000));

      // The deadline was registered with the broker as part of committing.
      expect(await timers.deadline("expiry")).toBeDefined();

      await sleep(5000);

      // The broker fired: a tick is waiting in the stream for this lineage.
      const tick = await jsm.streams.getMessage(STREAM, { last_by_subj: timers.tickSubject("expiry") });
      expect(tick).toBeTruthy();
      const origin = originFromScheduler(tick!.header!.get(SCHEDULER_HEADER), TIMER_PREFIX);
      expect(origin).toBe("expiry");

      // Consuming it drives the machine's timeout transition.
      const fired = await runtime.tick(origin!, Date.now());
      expect(fired).toBeGreaterThan(0);

      const res = await runtime.apply(Date.now(), {
        kind: "promise.get",
        head: head(),
        data: { id: "expiry" },
      });
      // `runtime.apply` returns the full Response union, so narrow on kind too.
      expect(res.kind).toBe("promise.get");
      if (res.kind === "promise.get" && isSuccess(res)) {
        expect(res.data.promise.state).toBe("rejected_timedout");
      }
    }, 30_000);

    test("a stalled task is re-dispatched by its retry timer", async () => {
      // The liveness case that matters most: an execute is dispatched, nobody
      // picks it up, and only the retry timer brings it back.
      const log = makeLog();
      const timers = makeTimers();
      const transport = new CollectingTransport();
      const runtime = new OriginRuntime({ log, timers, transport });

      const now = Date.now();
      await runtime.apply(now, createReq("stalled", now + 600_000, { "resonate:target": TARGET }));
      expect(transport.sent.filter((m) => m.message.kind === "execute")).toHaveLength(1);

      // The lineage's deadline is the task's 30s retry, well before the promise
      // timeout — so the timer that protects liveness is the one that is armed.
      const due = await timers.deadline("stalled");
      expect(due).toBeDefined();
      expect(due!).toBeLessThan(now + 600_000);

      // Drive the machine past the retry deadline: the task is re-dispatched.
      const fired = await runtime.tick("stalled", now + 40_000);
      expect(fired).toBeGreaterThan(0);
      expect(transport.sent.filter((m) => m.message.kind === "execute").length).toBeGreaterThanOrEqual(2);
    }, 30_000);
  });

  describe("contention under real parallelism", () => {
    beforeAll(freshStream);

    test("many runtimes racing one lineage lose nothing", async () => {
      // Genuinely parallel, not interleaved: each writer has its own runtime and
      // therefore its own cache, so they really do race on the conditional
      // append and really do have to resolve conflicts by re-materializing.
      const WRITERS = 12;
      const now = Date.now();
      const runtimes = Array.from({ length: WRITERS }, () => new OriginRuntime({ log: makeLog() }));

      const results = await Promise.allSettled(
        runtimes.map((rt, i) => rt.apply(now, createReq(`hot.w${i}`, now + 600_000))),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;

      const cold = new OriginRuntime({ log: makeLog() });
      const promises = Object.keys(snapshot(await cold.inspect("hot")).promises);

      // Every commit that reported success must be durably present, and no
      // committed write may have been clobbered by a racing writer.
      expect(promises.length).toBe(ok);
      for (let i = 0; i < WRITERS; i++) {
        const r = results[i];
        if (r.status === "fulfilled") expect(promises).toContain(`hot.w${i}`);
      }
    }, 60_000);

    test("a lineage stays consistent under sustained parallel load", async () => {
      const now = Date.now();
      const ROUNDS = 5;
      const PER_ROUND = 6;
      let expected = 0;

      for (let round = 0; round < ROUNDS; round++) {
        const rts = Array.from({ length: PER_ROUND }, () => new OriginRuntime({ log: makeLog() }));
        const res = await Promise.allSettled(
          rts.map((rt, i) => rt.apply(now, createReq(`load.r${round}i${i}`, now + 600_000))),
        );
        expected += res.filter((r) => r.status === "fulfilled").length;
      }

      const cold = new OriginRuntime({ log: makeLog() });
      expect(Object.keys(snapshot(await cold.inspect("load")).promises)).toHaveLength(expected);
    }, 120_000);
  });

  describe("real workflows over NATS", () => {
    beforeAll(freshStream);

    test("a generator workflow runs to completion against JetStream", async () => {
      const network = new DurableNetwork({ log: makeLog(), timers: makeTimers() });
      const resonate = new Resonate({ network });

      const greet = resonate.register("greet", function* (_ctx: Context, name: string) {
        return `hello ${name}`;
      });

      await expect(greet.run("nats-wf-1", "world")).resolves.toBe("hello world");
      await resonate.stop();
      await network.stop();
    }, 60_000);

    test("a workflow with children commits every step to JetStream", async () => {
      const network = new DurableNetwork({ log: makeLog(), timers: makeTimers() });
      const resonate = new Resonate({ network });

      const double = (_ctx: Context, n: number) => n * 2;
      const sum = resonate.register("sum", function* (ctx: Context, n: number) {
        let total = 0;
        for (let i = 1; i <= n; i++) total += yield* ctx.run(double, i);
        return total;
      });

      await expect(sum.run("nats-wf-2", 4)).resolves.toBe(20);
      await resonate.stop();
      await network.stop();
    }, 60_000);

    test("a completed workflow is not re-run by a fresh process", async () => {
      let executions = 0;
      const body = function* () {
        executions += 1;
        return "done";
      };

      const n1 = new DurableNetwork({ log: makeLog(), timers: makeTimers() });
      const r1 = new Resonate({ network: n1 });
      await expect(r1.register("once", body).run("nats-dedup")).resolves.toBe("done");
      await r1.stop();
      await n1.stop();
      expect(executions).toBe(1);

      // A brand new process, sharing only NATS, must return the durable result.
      const n2 = new DurableNetwork({ log: makeLog(), timers: makeTimers() });
      const r2 = new Resonate({ network: n2 });
      await expect(r2.register("once", body).run("nats-dedup")).resolves.toBe("done");
      await r2.stop();
      await n2.stop();
      expect(executions).toBe(1);
    }, 60_000);
  });
});
