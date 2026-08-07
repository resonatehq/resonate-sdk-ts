// The comparison showcase: the Wallet object implemented here is the SAME
// logic sketched for Restate, Cloudflare DO, and Temporal in the design
// discussion — this file is the proof that the Resonate version runs.
//
//   Wallet.topUp(amount)        -> balance += amount
//   Wallet.spend(amount, item)  -> guard funds; durable ledger step;
//                                  balance -= amount; if low, schedule a
//                                  delayed self-reminder (alarm)
//   Wallet.remind()             -> mark reminded
//
// Plus the one-substrate scenarios the other systems make hard:
//   * a durable function fans out an object call and a function call in one
//     Promise.all (entity request/response FROM a workflow, composed with
//     ordinary durable ops);
//   * any process attaches to an in-flight object message BY ID and awaits
//     its result durably (observer pattern).

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Context, Info } from "../../src/async/index.js";
import { Resonate } from "../../src/async/index.js";
import { LocalNetwork } from "../../src/network/local.js";
import { ChainObjects } from "../../src/objects/chain.js";
import { defineObject, type ObjectDef, type SlotResult } from "../../src/objects/types.js";

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

interface WalletState {
  balance: number;
  reminded: boolean;
}

// The ledger is a durable function: journaled to the message that runs it,
// executed exactly once per spend no matter how often the message replays.
const ledgerCalls: string[] = [];
const chargeLedger = async (_: Info, key: string, item: string, amount: number): Promise<string> => {
  ledgerCalls.push(`${key}:${item}:${amount}`);
  return `rcpt-${item}-${amount}`;
};

const walletDef = (): ObjectDef<WalletState> =>
  defineObject<WalletState>({
    name: "Wallet",
    initial: () => ({ balance: 0, reminded: false }),
    handlers: {
      topUp: async (ctx, amount: number) => {
        ctx.state.balance += amount;
        return ctx.state.balance;
      },
      spend: async (ctx, amount: number, item: string) => {
        if (ctx.state.balance < amount) {
          throw new Error(`insufficient funds: ${ctx.state.balance} < ${amount}`);
        }
        // Durable step: crash after this line and the replayed message will
        // NOT charge twice — the child promise dedups. This is the line
        // Cloudflare DO cannot write without hand-rolled intent rows.
        const receipt = await ctx.run<string>("chargeLedger", ctx.key, item, amount);
        ctx.state.balance -= amount;
        if (ctx.state.balance < 10) {
          // Delayed self-message (alarm). Does not occupy a mailbox slot
          // until it fires; unlimited count (vs one alarm per DO).
          await ctx.object(walletShared, ctx.key).sendLater?.("remind", [], 1500);
        }
        return { balance: ctx.state.balance, receipt };
      },
      remind: async (ctx) => {
        ctx.state.reminded = true;
        return true;
      },
    },
  });
// Self-reference for handlers (defs are matched by name at dispatch).
const walletShared = walletDef();

describe("showcase: the Wallet (same logic as the Restate/DO/Temporal sketches)", () => {
  test("guarded spend, durable ledger step, rollback on failure, delayed self-reminder", async () => {
    const h = harness();
    h.resonate.register("chargeLedger", chargeLedger);
    h.objects.register(walletShared);
    ledgerCalls.length = 0;

    const wallet = h.objects.get(walletShared, "alice");

    // Guard: no funds -> error to the caller, state untouched, no ledger
    // call, and — unlike Restate's default — NO infinite retry loop: the
    // mailbox simply advances.
    await expect(wallet.call("spend", 5, "coffee")).rejects.toThrow(/insufficient funds/);
    expect(ledgerCalls).toEqual([]);

    expect(await wallet.call("topUp", 50)).toBe(50);

    const out = await wallet.call<{ balance: number; receipt: string }>("spend", 45, "book");
    expect(out).toEqual({ balance: 5, receipt: "rcpt-book-45" });
    expect(ledgerCalls).toEqual(["alice:book:45"]); // exactly once

    // Balance dropped under 10 -> the handler scheduled a reminder 1.5s out.
    expect((await wallet.read()).state).toEqual({ balance: 5, reminded: false });
    await new Promise((r) => setTimeout(r, 4000)); // delay + server tick cadence
    expect((await wallet.read()).state).toEqual({ balance: 5, reminded: true });
  });

  test("one substrate: Promise.all over an object call and a function call, inside a workflow", async () => {
    const h = harness();
    h.resonate.register("chargeLedger", chargeLedger);
    h.objects.register(walletShared);

    const fraudScore = async (_: Info, user: string): Promise<number> => user.length * 7;
    h.resonate.register("fraudScore", fraudScore);

    // Entity request/response FROM a durable function, fanned out with an
    // ordinary durable call in a single Promise.all. In Temporal this edge
    // (workflow -> entity, with a result) is a signal-and-callback dance;
    // here both arms are just durable promises.
    const checkout = async (ctx: Context, user: string, item: string, price: number) => {
      const w = h.objects.in(ctx).get(walletShared, user);
      const [charge, fraud] = await Promise.all([
        w.call<{ balance: number; receipt: string }>("spend", price, item),
        ctx.rpc<number>("fraudScore", user),
      ]);
      return { ...charge, fraud };
    };
    h.resonate.register("checkout", checkout);

    await h.objects.get(walletShared, "bob").call("topUp", 100);
    const handle = await h.resonate.run("checkout-bob-1", checkout, "bob", "pizza", 30);
    expect(await handle.result()).toEqual({ balance: 70, receipt: "rcpt-pizza-30", fraud: 21 });
  });

  test("observer: any process attaches to an in-flight message by id and awaits its result", async () => {
    const h = harness();
    h.resonate.register("chargeLedger", chargeLedger);
    h.objects.register(walletShared);

    const wallet = h.objects.get(walletShared, "carol");
    await wallet.call("topUp", 20);

    // A one-way send returns the message's durable promise id — a stable,
    // shareable address for THIS message's outcome.
    const msgId = await wallet.send("spend", 12, "ticket");

    // "Another process" (any client that knows the id — a dashboard, a
    // crashed caller's replacement) awaits the same outcome durably.
    const observed = await h.resonate.get(msgId);
    const slot = (await observed.result()) as SlotResult<WalletState>;
    expect(slot.r).toEqual({ balance: 8, receipt: "rcpt-ticket-12" });
    expect(slot.s.balance).toBe(8);

    // And the mailbox is data: the object's full history is addressable.
    const m0 = (await (await h.resonate.get("o/Wallet/carol/m0")).result()) as SlotResult<WalletState>;
    expect(m0.r).toBe(20); // the topUp, still auditable
  });
});
