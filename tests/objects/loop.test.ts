// Durable-object prototype tests — Variant B (generation loop with mailbox,
// roll = continue-as-new, idle passivation + reactivation).

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { Resonate } from "../../src/async/index.js";
import { LocalNetwork } from "../../src/network/local.js";
import { LoopObjects } from "../../src/objects/loop.js";
import { defineObject } from "../../src/objects/types.js";

jest.setTimeout(60_000);

function harness() {
  const network = new LocalNetwork();
  const resonate = new Resonate({ network });
  const objects = new LoopObjects({ resonate, network });
  return { network, resonate, objects };
}

const counterDef = (opts?: { mailbox?: number; idle?: number }) =>
  defineObject<{ count: number }>({
    name: "Counter",
    initial: () => ({ count: 0 }),
    handlers: {
      increment: async (ctx, by: number) => {
        ctx.state.count += by;
        return ctx.state.count;
      },
    },
    options: { mailbox: opts?.mailbox ?? 4, idle: opts?.idle ?? 2000 },
  });

let stack: { resonate: Resonate }[] = [];
afterEach(async () => {
  for (const s of stack) await s.resonate.stop();
  stack = [];
});

describe("loop objects", () => {
  test("activation on first message; calls serialize within a generation", async () => {
    const h = harness();
    stack.push(h);
    const counter = h.objects.get(counterDef(), "seq");

    expect(await counter.call("increment", 1)).toBe(1);
    expect(await counter.call("increment", 2)).toBe(3);
    expect(await counter.call("increment", 3)).toBe(6);
  });

  test("mailbox exhaustion rolls generations (continue-as-new) without losing messages", async () => {
    const h = harness();
    stack.push(h);
    const def = counterDef({ mailbox: 2, idle: 2000 });
    const counter = h.objects.get(def, "roll");

    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await counter.call<number>("increment", 1));
    }
    expect(results).toEqual([1, 2, 3, 4, 5]); // across >= 3 generations
  });

  test("concurrent deposits serialize", async () => {
    const h = harness();
    stack.push(h);
    const def = counterDef({ mailbox: 4, idle: 2000 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.objects.get(def, "conc").call<number>("increment", 1)),
    );
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("idle passivation settles the generation; the next message reactivates with state intact", async () => {
    const h = harness();
    stack.push(h);
    const def = counterDef({ mailbox: 8, idle: 1200 });
    const counter = h.objects.get(def, "pass");

    expect(await counter.call("increment", 10)).toBe(10);

    // Wait past the idle window (+ server tick cadence): the loop closes its
    // mailbox and returns; the object is now fully passive (no pending work).
    await new Promise((r) => setTimeout(r, 4000));

    // The settled generation's snapshot is now readable without any worker.
    const { state } = await counter.read();
    expect(state?.count).toBe(10);

    // Reactivation: a fresh generation hydrates from the snapshot.
    expect(await counter.call("increment", 5)).toBe(15);
  });

  test("delete tombstones across generations", async () => {
    const h = harness();
    stack.push(h);
    const def = counterDef({ mailbox: 8, idle: 1500 });
    const counter = h.objects.get(def, "del");
    await counter.call("increment", 1);
    await counter.delete();
    await expect(counter.call("increment", 1)).rejects.toThrow(/deleted/);
  });
});
