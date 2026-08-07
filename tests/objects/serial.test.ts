// Durable-object prototype tests — Variant C (serialized dispatch via the
// emulated `resonate:serial` protocol extension).

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Context, Info } from "../../src/async/index.js";
import { Resonate } from "../../src/async/index.js";
import { LocalNetwork } from "../../src/network/local.js";
import { SerialDispatchNetwork, SerialObjects } from "../../src/objects/serial.js";
import { defineObject, type ObjectDef } from "../../src/objects/types.js";

jest.setTimeout(30_000);

function harness() {
  const network = new SerialDispatchNetwork(new LocalNetwork());
  const resonate = new Resonate({ network });
  const objects = new SerialObjects({ resonate, network });
  return { network, resonate, objects };
}

const counterDef = (effects?: { runs: number }) =>
  defineObject<{ count: number }>({
    name: "Counter",
    initial: () => ({ count: 0 }),
    handlers: {
      increment: async (ctx, by: number) => {
        if (effects) effects.runs++;
        ctx.state.count += by;
        return ctx.state.count;
      },
      fail: async () => {
        throw new Error("boom");
      },
    },
  });

let stack: { resonate: Resonate }[] = [];
afterEach(async () => {
  for (const s of stack) await s.resonate.stop();
  stack = [];
});

describe("serial objects (protocol extension)", () => {
  test("sequential calls mutate state and return results", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "seq");

    expect(await counter.call("increment", 1)).toBe(1);
    expect(await counter.call("increment", 2)).toBe(3);
    const { state, deleted } = await counter.read();
    expect(deleted).toBe(false);
    expect(state?.count).toBe(3);
  });

  test("concurrent invocations serialize in creation order, no probing anywhere", async () => {
    const h = harness();
    stack.push(h);
    const effects = { runs: 0 };
    const def = counterDef(effects);
    const counter = h.objects.get(def, "conc");

    const results = await Promise.all(Array.from({ length: 6 }, () => counter.call<number>("increment", 1)));
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(effects.runs).toBe(6); // bounded replay: one execution per invocation
  });

  test("handler error rolls back state; chain advances", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "err");
    await counter.call("increment", 5);
    await expect(counter.call("fail")).rejects.toThrow(/boom/);
    expect(await counter.call("increment", 0)).toBe(5);
  });

  test("delete tombstones", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "del");
    await counter.call("increment", 1);
    await counter.delete();
    await expect(counter.call("increment", 1)).rejects.toThrow(/deleted/);
  });

  test("function → object is ctx.rpc plus one tag; object → object works; one-way send is ctx.detached", async () => {
    const h = harness();
    stack.push(h);

    const audit: ObjectDef<{ entries: string[] }> = defineObject<{ entries: string[] }>({
      name: "Audit",
      initial: () => ({ entries: [] }),
      handlers: {
        log: async (ctx, entry: string) => {
          ctx.state.entries.push(entry);
          return ctx.state.entries.length;
        },
        entries: async (ctx) => ctx.state.entries,
      },
    });

    const account: ObjectDef<{ balance: number }> = defineObject<{ balance: number }>({
      name: "Account",
      initial: () => ({ balance: 100 }),
      handlers: {
        withdraw: async (ctx, amount: number) => {
          ctx.state.balance -= amount;
          // object → object, one-way: durably created, never awaited.
          await ctx.object(audit, "trail").send("log", `withdraw ${amount} from ${ctx.key}`);
          return ctx.state.balance;
        },
      },
    });
    h.objects.register(audit);
    h.objects.register(account);

    const wf = async (ctx: Context): Promise<number> => {
      const acc = h.objects.in(ctx).get(account, "a1");
      await acc.call<number>("withdraw", 10);
      const balance = await acc.call<number>("withdraw", 20);
      return balance;
    };
    h.resonate.register("wf-serial", wf);

    const handle = await h.resonate.run("wf-serial-1", wf);
    expect(await handle.result()).toBe(70);

    // The one-way sends landed (poll briefly — they are async by design).
    const trail = h.objects.get(audit, "trail");
    let entries: string[] = [];
    for (let i = 0; i < 40 && entries.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      entries = await trail.call<string[]>("entries");
    }
    expect(entries).toEqual(["withdraw 10 from a1", "withdraw 20 from a1"]);
  });

  test("object → function: handlers run durable children", async () => {
    const h = harness();
    stack.push(h);
    const double = async (_: Info, n: number) => n * 2;
    h.resonate.register("double", double);

    const def = defineObject<{ total: number }>({
      name: "Doubler",
      initial: () => ({ total: 0 }),
      handlers: {
        add: async (ctx, n: number) => {
          const d = await ctx.run<number>("double", n);
          ctx.state.total += d;
          return ctx.state.total;
        },
      },
    });
    h.objects.register(def);
    expect(await h.objects.get(def, "d1").call("add", 21)).toBe(42);
  });
});
