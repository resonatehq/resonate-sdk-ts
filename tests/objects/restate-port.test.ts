// Port of Restate's two flagship agent examples onto durable objects, run on
// the sequencer-mode chain runtime. The originals (verbatim sources:
// restatedev/ai-examples @ vercel-ai/template/src/app.ts and
// vercel-ai/tour-of-agents/src/chat-agent.ts):
//
//   1. "Durable Agent"  — a stateless service whose handler runs the LLM/tool
//      loop; LLM responses journaled by the durableCalls middleware (which is
//      ctx.run under the hood), tools journaled via ctx.run.
//   2. "Durable Session" — a Virtual Object "Chat": exclusive `message`
//      handler does ctx.get(history) → generateText → ctx.set(history);
//      a shared handler `getHistory` serves concurrent reads.
//
// The port maps: service → durable function; virtual object → durable object;
// ctx.get/ctx.set K/V → ctx.state (committed atomically with the reply);
// durableCalls middleware → ctx.run around the model call; tool ctx.run →
// ctx.run; shared handler → read() (no handler, no worker); objectClient →
// objects.get / objects.in(ctx).get.
//
// The LLM is a deterministic script (tests run offline): first call returns a
// getWeather tool call, second returns the final text — the same shape the
// AI SDK's generateText loop produces with stopWhen: stepCountIs(5).

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Context, Info } from "../../src/async/index.js";
import { Resonate } from "../../src/async/index.js";
import { LocalNetwork } from "../../src/network/local.js";
import { ChainObjects } from "../../src/objects/chain.js";
import { SequencerNetwork } from "../../src/objects/seq.js";
import { defineObject } from "../../src/objects/types.js";

jest.setTimeout(30_000);

let stack: { resonate: Resonate }[] = [];
afterEach(async () => {
  for (const s of stack) await s.resonate.stop();
  stack = [];
});

// -- model + tool (the scripted stand-ins for openai() and the weather API) --

type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };
type LLMStep = { text: string; toolCalls: { name: string; args: { city: string } }[] };

const counts = { llm: 0, weather: 0 };

// durableCalls(ctx) ≙ this leaf: one journaled step per LLM response.
const generateStep = async (_: Info, messages: ModelMessage[]): Promise<LLMStep> => {
  counts.llm++;
  const last = messages[messages.length - 1];
  if (last.role === "tool") {
    return { text: `It is sunny and warm in San Francisco (23°C).`, toolCalls: [] };
  }
  return { text: "", toolCalls: [{ name: "getWeather", args: { city: "San Francisco" } }] };
};

// getWeather(ctx, city) ≙ this leaf: the tool's durable step.
const getWeather = async (_: Info, city: string) => {
  counts.weather++;
  return { temperature: 23, description: "Sunny and warm.", city };
};

// -- 1. the "Durable Agent" service → a durable function ---------------------
//
// Restate:  const run = async (ctx, { prompt }) => generateText({ model:
//           wrapLanguageModel({ model, middleware: durableCalls(ctx) }),
//           tools: { getWeather: ... execute: ({city}) => getWeather(ctx, city) },
//           stopWhen: [stepCountIs(5)] })
const agentRun = async (ctx: Context, prompt: string): Promise<string> => {
  let messages: ModelMessage[] = [
    { role: "system", content: "You are a helpful agent that provides weather updates." },
    { role: "user", content: prompt },
  ];
  for (let step = 0; step < 5; step++) {
    // stopWhen: stepCountIs(5)
    const res = await ctx.run<LLMStep>("generateStep", messages); // durableCalls
    if (res.toolCalls.length === 0) return res.text;
    for (const call of res.toolCalls) {
      const out = await ctx.run("getWeather", call.args.city); // tool ctx.run
      messages = [...messages, { role: "tool", content: JSON.stringify(out) }];
    }
  }
  throw new Error("step budget exhausted");
};

// -- 2. the "Durable Session" virtual object → a durable object --------------
//
// Restate:  restate.object({ name: "Chat", handlers: {
//             message: exclusive — ctx.get("messages") → generateText → ctx.set,
//             getHistory: shared — ctx.get("messages") } })
const chat = defineObject<{ messages: ModelMessage[] }>({
  name: "Chat",
  initial: () => ({ messages: [] }),
  handlers: {
    message: async (ctx, text: string) => {
      ctx.state.messages.push({ role: "user", content: text }); // ctx.get + push
      // object → function: the session delegates the turn to the agent loop
      // (Restate's examples run the loop inline in the handler; both work —
      // this is the composed version, their service and object on one substrate).
      const answer = await ctx.rpc<string>("agentRun", text);
      ctx.state.messages.push({ role: "assistant", content: answer }); // ctx.set
      return { answer };
    },
    // getHistory needs no handler: read() serves the committed snapshot
    // without entering the mailbox (vs. a shared handler on a worker).
  },
});

function harness() {
  const network = new SequencerNetwork(new LocalNetwork());
  const resonate = new Resonate({ network });
  const objects = new ChainObjects({ resonate, network, sequencer: true });
  resonate.register("generateStep", generateStep);
  resonate.register("getWeather", getWeather);
  resonate.register("agentRun", agentRun);
  objects.register(chat);
  stack.push({ resonate });
  return { resonate, objects };
}

describe("Restate flagship examples, ported", () => {
  test("durable agent: LLM/tool loop as a durable function", async () => {
    const h = harness();
    counts.llm = 0;
    counts.weather = 0;

    const handle = await h.resonate.run("agent-1", agentRun, "What's the weather in San Francisco?");
    expect(await handle.result()).toMatch(/sunny and warm/i);
    expect(counts.llm).toBe(2); // tool-call step + final step, exactly once each
    expect(counts.weather).toBe(1);
  });

  test("durable session: chat object with serialized turns and worker-free history reads", async () => {
    const h = harness();
    counts.llm = 0;
    counts.weather = 0;

    const session = h.objects.get(chat, "session-42");

    const r1 = await session.call<{ answer: string }>("message", "What's the weather in SF?");
    expect(r1.answer).toMatch(/sunny/i);

    const r2 = await session.call<{ answer: string }>("message", "And tomorrow?");
    expect(r2.answer).toMatch(/sunny/i);

    // getHistory, without a handler: the committed snapshot.
    const { state } = await session.read();
    expect(state?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    // Two turns → two full agent loops, each exactly once.
    expect(counts.llm).toBe(4);
    expect(counts.weather).toBe(2);
  });

  test("session turns serialize: concurrent messages queue like Restate's per-key queue", async () => {
    const h = harness();
    const session = h.objects.get(chat, "session-conc");

    const answers = await Promise.all([
      session.call<{ answer: string }>("message", "one"),
      session.call<{ answer: string }>("message", "two"),
      session.call<{ answer: string }>("message", "three"),
    ]);
    expect(answers).toHaveLength(3);

    const { state } = await session.read();
    // Strict alternation proves the turns did not interleave mid-handler.
    expect(state?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });
});
