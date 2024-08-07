import { describe, test, expect, jest } from "@jest/globals";
import { options } from "../lib/core/options";
import * as retry from "../lib/core/retry";
import * as utils from "../lib/core/utils";
import { Resonate, Context } from "../lib/resonate";

jest.setTimeout(10000);

describe("Functions: async", () => {
  async function run(ctx: Context, func: any) {
    return await ctx.run(func);
  }

  function ordinarySuccess() {
    return "foo";
  }

  function ordinaryFailure() {
    throw new Error("foo");
  }

  async function ordinarySuccessAsync() {
    return "foo";
  }

  async function ordinaryFailureAsync() {
    throw new Error("foo");
  }

  async function deferredSuccess(ctx: Context) {
    return await ctx.run("success", options({ pollFrequency: 0 }));
  }

  async function deferredFailure(ctx: Context) {
    return await ctx.run("failure", options({ pollFrequency: 0 }));
  }

  test("success", async () => {
    const resonate = new Resonate({
      timeout: 1000,
      retryPolicy: retry.exponential(
        100, // initial delay (in ms)
        2, // backoff factor
        Infinity, // max attempts
        60000, // max delay (in ms, 1 minute)
      ),
    });

    resonate.register("run", run);
    resonate.register("success", ordinarySuccess);
    resonate.register("successAsync", ordinarySuccessAsync);

    // pre-resolve deferred
    const deferred = await resonate.promises.create("success", Date.now() + 1000, {
      idempotencyKey: utils.hash("success"),
    });
    deferred.resolve("foo");

    const results: string[] = [
      ordinarySuccess(),
      await ordinarySuccessAsync(),
      await resonate.run("run", "run.a", ordinarySuccess),
      await resonate.run("run", "run.b", ordinarySuccessAsync),
      await resonate.run("run", "run.c", deferredSuccess),
      await resonate.run("success", "run.d"),
      await resonate.run("successAsync", "run.e"),
    ];

    expect(results.every((r) => r === "foo")).toBe(true);
  });

  test("failure", async () => {
    const resonate = new Resonate({
      timeout: 1000,
      retryPolicy: retry.linear(0, 3),
    });

    resonate.register("run", run);
    resonate.register("failure", ordinaryFailure);
    resonate.register("failureAsync", ordinaryFailureAsync);

    // pre-reject deferred
    const deferred = await resonate.promises.create("failure", Date.now() + 1000, {
      idempotencyKey: utils.hash("failure"),
    });
    deferred.reject(new Error("foo"));

    const functions = [
      () => ordinaryFailureAsync(),
      () => resonate.run("run", "run.a", ordinaryFailure),
      () => resonate.run("run", "run.b", ordinaryFailureAsync),
      () => resonate.run("run", "run.c", deferredFailure),
      () => resonate.run("failure", "run.d"),
      () => resonate.run("failureAsync", "run.e"),
    ];

    for (const f of functions) {
      await expect(f()).rejects.toThrow("foo");
    }
  });
});
