// Durable-object prototype tests — the sequencer extension (resonate:seq):
// server-assigned dense message ids. Chain semantics, one-RPC enqueue.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { Resonate } from "../../src/async/index.js";
import { Codec } from "../../src/codec.js";
import { LocalNetwork } from "../../src/network/local.js";
import type { Request } from "../../src/network/types.js";
import { ChainObjects } from "../../src/objects/chain.js";
import { SequencerNetwork } from "../../src/objects/seq.js";
import { defineObject } from "../../src/objects/types.js";
import { createPromise } from "../../src/objects/wire.js";

jest.setTimeout(30_000);

let stack: { resonate: Resonate }[] = [];
afterEach(async () => {
  for (const s of stack) await s.resonate.stop();
  stack = [];
});

function harness() {
  const inner = new LocalNetwork();
  const network = new SequencerNetwork(inner);
  const resonate = new Resonate({ network });
  const objects = new ChainObjects({ resonate, network, sequencer: true });
  stack.push({ resonate });
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
    },
  });

describe("sequencer-mode chain objects", () => {
  test("sequential calls: dense server-assigned ids, correct state", async () => {
    const h = harness();
    const counter = h.objects.get(counterDef(), "seq");

    expect(await counter.call("increment", 1)).toBe(1);
    expect(await counter.call("increment", 2)).toBe(3);
    const { state } = await counter.read();
    expect(state?.count).toBe(3);
  });

  test("concurrent senders: serialized, exactly once, no CAS retries", async () => {
    const h = harness();
    const effects = { runs: 0 };
    const def = counterDef(effects);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.objects.get(def, "conc").call<number>("increment", 1)),
    );
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(effects.runs).toBe(6);
  });

  test("idempotent append: a retry with the same seq-ik lands on the same id", async () => {
    const h = harness();
    const codec = new Codec();
    const mk = () =>
      createPromise(h.network.send, codec, {
        id: "",
        timeoutAt: Date.now() + 60_000,
        data: { v: 1 },
        tags: { "resonate:seq": "o/Dedup/k", "resonate:seq-ik": "send-123" },
      });

    const first = await mk();
    const retry = await mk(); // crashed-sender retry: same ik
    expect(first.id).toBe("o/Dedup/k:m0");
    expect(retry.id).toBe(first.id); // same slot, not a double-append
    const other = await createPromise(h.network.send, codec, {
      id: "",
      timeoutAt: Date.now() + 60_000,
      data: { v: 2 },
      tags: { "resonate:seq": "o/Dedup/k", "resonate:seq-ik": "send-456" },
    });
    expect(other.id).toBe("o/Dedup/k:m1"); // counter advanced exactly once for ik-123
  });

  test("enqueue is probe-free: appends issue no promise.get traffic once warm", async () => {
    const inner = new LocalNetwork();
    let gets = 0;
    const counting = new Proxy(inner, {
      get(target, prop) {
        if (prop === "send") {
          return (req: Request) => {
            if (req.kind === "promise.get") gets++;
            return inner.send(req as never);
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as LocalNetwork;
    const network = new SequencerNetwork(counting);
    const resonate = new Resonate({ network });
    const objects = new ChainObjects({ resonate, network, sequencer: true });
    stack.push({ resonate });

    const counter = objects.get(counterDef(), "probe-free");
    await counter.call("increment", 1); // first append: one counter-recovery probe allowed

    const before = gets;
    await counter.call("increment", 1);
    await counter.call("increment", 1);
    // Appends are a single create each; the only gets are the dispatcher's
    // effects-cache misses, never a client-side head probe (which would
    // gallop and grow with chain length).
    expect(gets - before).toBeLessThanOrEqual(2);
  });
});
