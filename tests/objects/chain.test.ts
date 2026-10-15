// Durable-object prototype tests — Variant A (message chain).
//
// Everything runs against the in-process LocalNetwork server model: real
// durable promises, real tasks, real suspend/resume — no mocks.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Context, Info } from "../../src/async/index.js";
import { Resonate } from "../../src/async/index.js";
import { LocalNetwork } from "../../src/network/local.js";
import { ChainObjects } from "../../src/objects/chain.js";
import { defineObject, ObjectCallError, type ObjectDef } from "../../src/objects/types.js";

jest.setTimeout(30_000);

interface CounterState {
  count: number;
  log: string[];
}

function harness() {
  const network = new LocalNetwork();
  const resonate = new Resonate({ network });
  const objects = new ChainObjects({ resonate, network });
  return { network, resonate, objects };
}

// A fresh def per test id-space; keys isolate objects anyway, but tests also
// use distinct keys to avoid cross-test chains.
const counterDef = (handlerEffects?: { runs: number }) =>
  defineObject<CounterState>({
    name: "Counter",
    initial: () => ({ count: 0, log: [] }),
    handlers: {
      increment: async (ctx, by: number) => {
        if (handlerEffects) handlerEffects.runs++;
        ctx.state.count += by;
        ctx.state.log.push(`+${by}`);
        return ctx.state.count;
      },
      fail: async () => {
        throw new Error("boom");
      },
      get: async (ctx) => ctx.state.count,
    },
  });

let stack: { resonate: Resonate }[] = [];
afterEach(async () => {
  for (const s of stack) await s.resonate.stop();
  stack = [];
});

describe("chain objects", () => {
  test("sequential calls mutate state and return results", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "seq");

    expect(await counter.call("increment", 1)).toBe(1);
    expect(await counter.call("increment", 2)).toBe(3);
    expect(await counter.call("increment", 3)).toBe(6);

    const { state, deleted } = await counter.read();
    expect(deleted).toBe(false);
    expect(state?.count).toBe(6);
    expect(state?.log).toEqual(["+1", "+2", "+3"]);
  });

  test("concurrent senders serialize; every message lands exactly once", async () => {
    const h = harness();
    stack.push(h);
    const effects = { runs: 0 };
    const def = counterDef(effects);
    const counter = h.objects.get(def, "conc");

    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.objects.get(def, "conc").call<number>("increment", 1)),
    );

    // Serialized execution: results are a permutation of 1..6 (each message
    // observed a distinct predecessor state).
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await counter.read()).state?.count).toBe(6);
    // Bounded replay: 6 messages, 6 handler executions — hydration reads the
    // predecessor SNAPSHOT, it does not re-run history.
    expect(effects.runs).toBe(6);
  });

  test("handler error: caller sees the error, state rolls back, chain advances", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "err");

    await counter.call("increment", 5);
    await expect(counter.call("fail")).rejects.toThrow(ObjectCallError);
    // The failed message did not wedge the object or corrupt state.
    expect(await counter.call("get")).toBe(5);
  });

  test("unknown method is an error, not a wedge", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "unknown");
    await expect(counter.call("nope")).rejects.toThrow(/no handler 'nope'/);
    expect(await counter.call("increment", 1)).toBe(1);
  });

  test("delete tombstones the object", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "del");
    await counter.call("increment", 1);
    await counter.delete();
    await expect(counter.call("increment", 1)).rejects.toThrow(/deleted/);
    const { state, deleted } = await counter.read();
    expect(deleted).toBe(true);
    expect(state).toBeUndefined();
  });

  test("function → object: a durable function calls an object and suspends on it", async () => {
    const h = harness();
    stack.push(h);
    const def = counterDef();
    h.objects.register(def);

    const wf = async (ctx: Context, key: string): Promise<number> => {
      const c = h.objects.in(ctx).get(def, key);
      const a = await c.call<number>("increment", 10);
      const b = await c.call<number>("increment", 5);
      return a + b;
    };
    h.resonate.register("wf-f2o", wf);

    const handle = await h.resonate.run("wf-f2o-1", wf, "f2o");
    expect(await handle.result()).toBe(25); // 10 + 15
    expect((await h.objects.get(def, "f2o").read()).state?.count).toBe(15);
  });

  test("object → function: handlers use ctx.run and ctx.rpc like any workflow", async () => {
    const h = harness();
    stack.push(h);

    const double = async (_: Info, n: number) => n * 2;
    h.resonate.register("double", double);

    const def = defineObject<{ total: number }>({
      name: "Doubler",
      initial: () => ({ total: 0 }),
      handlers: {
        add: async (ctx, n: number) => {
          const doubled = await ctx.run<number>("double", n); // local durable child
          const doubledAgain = await ctx.rpc<number>("double", doubled); // remote durable child
          ctx.state.total += doubledAgain;
          return ctx.state.total;
        },
      },
    });
    h.objects.register(def);

    const obj = h.objects.get(def, "d1");
    expect(await obj.call("add", 3)).toBe(12);
    expect(await obj.call("add", 1)).toBe(16);
  });

  test("object → object: transfer across two objects of the same type", async () => {
    const h = harness();
    stack.push(h);

    const account: ObjectDef<{ balance: number }> = defineObject<{ balance: number }>({
      name: "Account",
      initial: () => ({ balance: 100 }),
      handlers: {
        credit: async (ctx, amount: number) => {
          ctx.state.balance += amount;
          return ctx.state.balance;
        },
        transfer: async (ctx, to: string, amount: number) => {
          ctx.state.balance -= amount;
          const target = ctx.object(account, to);
          const targetBalance = await target.call<number>("credit", amount);
          return { mine: ctx.state.balance, theirs: targetBalance };
        },
        balance: async (ctx) => ctx.state.balance,
      },
    });
    h.objects.register(account);

    const a = h.objects.get(account, "acc-a");
    const out = await a.call<{ mine: number; theirs: number }>("transfer", "acc-b", 30);
    expect(out).toEqual({ mine: 70, theirs: 130 });
    expect(await h.objects.get(account, "acc-b").call("balance")).toBe(130);
  });

  test("self: send is allowed, call is rejected as a deadlock", async () => {
    const h = harness();
    stack.push(h);

    const pinger: ObjectDef<{ pings: number }> = defineObject<{ pings: number }>({
      name: "Pinger",
      initial: () => ({ pings: 0 }),
      handlers: {
        kick: async (ctx) => {
          ctx.state.pings += 1;
          if (ctx.state.pings < 3) {
            await ctx.object(pinger, ctx.key).send("kick"); // self-send: fine
          }
          return ctx.state.pings;
        },
        deadlock: async (ctx) => {
          ctx.object(pinger, ctx.key).call("kick"); // self-call: deadlock
          return "unreachable";
        },
        pings: async (ctx) => ctx.state.pings,
      },
    });
    h.objects.register(pinger);

    const p = h.objects.get(pinger, "p1");
    await p.call("kick");
    // The self-sends chain through the mailbox; wait for them to drain.
    await new Promise((r) => setTimeout(r, 500));
    expect(await p.call("pings")).toBe(3);

    // The guard trips inside the handler; the caller sees it as the call's error.
    await expect(p.call("deadlock")).rejects.toThrow(/awaited the result/);
  });

  test("alarms: sendLater delivers a message after the delay", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "alarm");

    await counter.call("increment", 1);
    await counter.sendLater("increment", [41], 1200);
    expect((await counter.read()).state?.count).toBe(1); // not yet

    await new Promise((r) => setTimeout(r, 3500)); // delay + server tick cadence
    expect((await counter.read()).state?.count).toBe(42);
  });
});
