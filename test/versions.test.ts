import { describe, test, expect, jest } from "@jest/globals";
import { options } from "../lib/core/options";
import { Resonate, Context } from "../lib/resonate";

jest.setTimeout(10000);

describe("Functions: versions", () => {
  const resonate = new Resonate();
  resonate.register("test", (ctx: Context) => ({ v: "v1", c: ctx.invocationData.opts.version }));
  resonate.register("test", (ctx: Context) => ({ v: "v2", c: ctx.invocationData.opts.version }), { version: 2 });
  resonate.register("test", (ctx: Context) => ({ v: "v3", c: ctx.invocationData.opts.version }), { version: 3 });

  test("should return v1", async () => {
    const result = await resonate.run("test", "a", options({ version: 1 }));
    expect(result).toMatchObject({ v: "v1", c: 1 });
  });

  test("should return v2", async () => {
    const result = await resonate.run("test", "b", options({ version: 2 }));
    expect(result).toMatchObject({ v: "v2", c: 2 });
  });

  test("should return v3", async () => {
    const r1 = await resonate.run("test", "c", options({ version: 3 }));
    expect(r1).toMatchObject({ v: "v3", c: 3 });

    const r2 = await resonate.run("test", "d", options({ version: 0 }));
    expect(r2).toMatchObject({ v: "v3", c: 3 });

    const r3 = await resonate.run("test", "e");
    expect(r3).toMatchObject({ v: "v3", c: 3 });
  });
});
