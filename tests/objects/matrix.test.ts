// The recursive-integration matrix: durable functions and durable objects
// composing in every direction, on the chain runtime.
//
//   function → function   (SDK baseline, included for completeness)
//   function → object     (workflow suspends on an object call)
//   object   → function   (handler runs local + remote durable children)
//   object   → object     (handler calls another object)
//   deep:  function → object → function → object   (arbitrary nesting)
//   cycle: object A ⇄ object B via one-way sends   (no deadlock)

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Context, Info } from "../../src/async/index.js";
import { Resonate } from "../../src/async/index.js";
import { LocalNetwork } from "../../src/network/local.js";
import { ChainObjects } from "../../src/objects/chain.js";
import { defineObject, type ObjectDef } from "../../src/objects/types.js";

jest.setTimeout(60_000);

let stack: { resonate: Resonate }[] = [];
afterEach(async () => {
  for (const s of stack) await s.resonate.stop();
  stack = [];
});

function harness() {
  const network = new LocalNetwork();
  const resonate = new Resonate({ network });
  const objects = new ChainObjects({ resonate, network });
  stack.push({ resonate });
  return { network, resonate, objects };
}

describe("recursion matrix", () => {
  test("function → function → object → function → object (deep nesting)", async () => {
    const h = harness();

    // Leaf function.
    const tax = async (_: Info, amount: number) => Math.round(amount * 0.1);
    h.resonate.register("tax", tax);

    // Inventory object: handler calls a durable function (object → function).
    const inventory = defineObject<{ stock: number }>({
      name: "Inventory",
      initial: () => ({ stock: 10 }),
      handlers: {
        reserve: async (ctx, qty: number) => {
          ctx.state.stock -= qty;
          return ctx.state.stock;
        },
      },
    });

    // Order object: handler calls a durable WORKFLOW via rpc (object →
    // function), which in turn calls the inventory OBJECT (function → object).
    const orders = defineObject<{ placed: string[] }>({
      name: "Orders",
      initial: () => ({ placed: [] }),
      handlers: {
        place: async (ctx, sku: string, qty: number, amount: number) => {
          const taxed = await ctx.run<number>("tax", amount); // object → function (local)
          const remaining = await ctx.rpc<number>("fulfill", sku, qty); // object → function (remote workflow)
          ctx.state.placed.push(sku);
          return { taxed, remaining, total: amount + taxed };
        },
      },
    });

    // The fulfillment workflow — a durable function that calls an object.
    const fulfill = async (ctx: Context, _sku: string, qty: number): Promise<number> => {
      const inv = h.objects.in(ctx).get(inventory, "main");
      return inv.call<number>("reserve", qty); // function → object
    };
    h.resonate.register("fulfill", fulfill);
    h.objects.register(inventory);
    h.objects.register(orders);

    // Top-level workflow — function → function → object → ...
    const checkout = async (ctx: Context, sku: string): Promise<any> => {
      const order = h.objects.in(ctx).get(orders, "cart-1");
      return order.call("place", sku, 3, 100); // function → object
    };
    h.resonate.register("checkout", checkout);

    const handle = await h.resonate.run("checkout-1", checkout, "widget");
    expect(await handle.result()).toEqual({ taxed: 10, remaining: 7, total: 110 });

    expect((await h.objects.get(inventory, "main").read()).state?.stock).toBe(7);
    expect((await h.objects.get(orders, "cart-1").read()).state?.placed).toEqual(["widget"]);
  });

  test("object ⇄ object cycle via one-way sends terminates without deadlock", async () => {
    const h = harness();

    const player: ObjectDef<{ hits: number }> = defineObject<{ hits: number }>({
      name: "Player",
      initial: () => ({ hits: 0 }),
      handlers: {
        volley: async (ctx, from: string, rally: number) => {
          ctx.state.hits += 1;
          if (rally > 0) {
            // One-way send back — a CALL here would be the classic A ⇄ B
            // distributed deadlock (both serialized objects awaiting each
            // other's mailbox). Sends queue instead of block.
            await ctx.object(player, from).send("volley", ctx.key, rally - 1);
          }
          return ctx.state.hits;
        },
        hits: async (ctx) => ctx.state.hits,
      },
    });
    h.objects.register(player);

    await h.objects.get(player, "alice").call("volley", "bob", 5);

    // alice: rally 5, then receives 4, 2, 0 → let the sends drain.
    const alice = h.objects.get(player, "alice");
    const bob = h.objects.get(player, "bob");
    let a = 0;
    let b = 0;
    for (let i = 0; i < 50 && a + b < 6; i++) {
      await new Promise((r) => setTimeout(r, 100));
      a = (await alice.read()).state?.hits ?? 0;
      b = (await bob.read()).state?.hits ?? 0;
    }
    expect(a).toBe(3); // rallies 5, 3, 1 land on... alice got initial + 4th + 2nd
    expect(b).toBe(3);
  });

  test("object → detached function: fire-and-forget workflows from handlers", async () => {
    const h = harness();

    const seen: string[] = [];
    const audit = async (_: Info, entry: string) => {
      seen.push(entry);
      return entry;
    };
    h.resonate.register("audit", audit);

    const vault = defineObject<{ ops: number }>({
      name: "Vault",
      initial: () => ({ ops: 0 }),
      handlers: {
        put: async (ctx, item: string) => {
          ctx.state.ops += 1;
          await ctx.detached("audit", `put ${item}`); // object → detached function
          return ctx.state.ops;
        },
      },
    });
    h.objects.register(vault);

    expect(await h.objects.get(vault, "v1").call("put", "gold")).toBe(1);
    for (let i = 0; i < 30 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen).toEqual(["put gold"]);
  });
});
