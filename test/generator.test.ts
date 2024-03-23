import { describe, test, expect, jest } from "@jest/globals";
import { Retry } from "../lib/core/retries/retry";
import { Resonate, Context } from "../lib/generator";

jest.setTimeout(10000);

describe("Generator functions", () => {
  function* run(ctx: Context, func: any): Generator<any> {
    return yield ctx.run(func);
  }

  function* call(ctx: Context, func: any): Generator<any> {
    return yield yield ctx.call(func);
  }

  function* callFuture(ctx: Context, func: any): Generator<any> {
    return yield ctx.call(func);
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

  function* generatorSuccess() {
    return "foo";
  }

  function* generatorFailure() {
    throw new Error("foo");
  }

  test("success", async () => {
    const resonate = new Resonate({
      timeout: 1000,
      retry: Retry.linear(0, 3),
    });

    resonate.register("run", run);
    resonate.register("call", call);
    resonate.register("callFuture", callFuture);

    const results: string[] = [
      ordinarySuccess(),
      await ordinarySuccessAsync(),
      await resonate.run("run", "run.a", ordinarySuccess),
      await resonate.run("run", "run.b", ordinarySuccessAsync),
      await resonate.run("run", "run.c", generatorSuccess),
      await resonate.run("call", "run.d", ordinarySuccess),
      await resonate.run("call", "run.e", ordinarySuccessAsync),
      await resonate.run("call", "run.f", generatorSuccess),
      await resonate.run("callFuture", "run.g", ordinarySuccess),
      await resonate.run("callFuture", "run.h", ordinarySuccessAsync),
      await resonate.run("callFuture", "run.i", generatorSuccess),
    ];

    expect(results.every((r) => r === "foo")).toBe(true);
  });

  test("failure", async () => {
    const resonate = new Resonate({
      timeout: 1000,
      retry: Retry.linear(0, 3),
    });

    resonate.register("run", run);
    resonate.register("call", call);
    resonate.register("callFuture", callFuture);

    const functions = [
      () => ordinaryFailureAsync(),
      () => resonate.run("run", "run.a", ordinaryFailure),
      () => resonate.run("run", "run.b", ordinaryFailureAsync),
      () => resonate.run("run", "run.c", generatorFailure),
      () => resonate.run("call", "run.d", ordinaryFailure),
      () => resonate.run("call", "run.e", ordinaryFailureAsync),
      () => resonate.run("call", "run.f", generatorFailure),
      () => resonate.run("callFuture", "run.g", ordinaryFailure),
      () => resonate.run("callFuture", "run.h", ordinaryFailureAsync),
      () => resonate.run("callFuture", "run.i", generatorFailure),
    ];

    for (const f of functions) {
      await expect(f()).rejects.toThrow("foo");
    }
  });
});
