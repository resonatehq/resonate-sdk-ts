// Durable-object prototype tests — Variant D (optimistic CAS state chain,
// the rejected alternative: pure folds only, no durable effects).

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { LocalNetwork } from "../../src/network/local.js";
import { CasObjects, type ReducerDef } from "../../src/objects/cas.js";

jest.setTimeout(30_000);

const counter: ReducerDef<{ count: number }> = {
  name: "Counter",
  initial: () => ({ count: 0 }),
  reducers: {
    increment: (s, by: number) => ({ count: s.count + by }),
  },
};

let network: LocalNetwork;
afterEach(async () => {
  await network?.stop();
});

describe("cas objects (rejected alternative)", () => {
  test("sequential applies fold state", async () => {
    network = new LocalNetwork();
    const objects = new CasObjects({ network });
    const c = objects.get(counter, "seq");
    expect((await c.apply("increment", 1)).count).toBe(1);
    expect((await c.apply("increment", 2)).count).toBe(3);
    expect((await c.read()).count).toBe(3);
  });

  test("concurrent applies all land exactly once (CAS retry under contention)", async () => {
    network = new LocalNetwork();
    const objects = new CasObjects({ network });
    await Promise.all(Array.from({ length: 8 }, () => objects.get(counter, "conc").apply("increment", 1)));
    expect((await objects.get(counter, "conc").read()).count).toBe(8);
  });
});
