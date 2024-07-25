import { fail } from "assert";
import { describe, test, expect, jest } from "@jest/globals";
import { ErrorCodes, linear, never, options, ResonateError } from "../lib";
import { Context, Resonate } from "../lib/resonate";

jest.setTimeout(10000);
describe("User Defined Resources", () => {
  test("Set and get a resource", async () => {
    const resonate = new Resonate();

    resonate.register("resource", async (ctx: Context, resourceVal: unknown) => {
      ctx.setResource("mock", resourceVal);
      return ctx.getResource("mock");
    });

    const resourceVal = {};
    const handle = await resonate.invokeLocal<void>("resource", "resource.0", resourceVal);

    await expect(handle.result()).resolves.toBe(resourceVal);
  });

  test("Set a resource and get it deep in the context stack", async () => {
    const resonate = new Resonate();

    resonate.register(
      "resource",
      async (ctx: Context, val: string) => {
        ctx.setResource("res", val);
        return await ctx.run(async (ctx: Context) => {
          return await ctx.run(async (ctx: Context) => {
            return await ctx.run(async (ctx: Context) => {
              return ctx.getResource("res");
            });
          });
        });
      },
      options({ retryPolicy: never() }),
    );

    const res = "resource";
    const handle = await resonate.invokeLocal<string>("resource", "resource.0", res);
    await expect(handle.result()).resolves.toBe(res);
  });

  test("Finalizers are called in reverse definition order", async () => {
    const resonate = new Resonate();

    const arr: number[] = [];
    resonate.register(
      "res",
      async (ctx: Context) => {
        ctx.setResource("4", 4, async () => {
          arr.push(4);
        });

        ctx.setResource("3", 3, async () => {
          arr.push(3);
        });

        ctx.setResource("2", 2, async () => {
          arr.push(2);
        });

        ctx.setResource("1", 1, async () => {
          arr.push(1);
        });
      },
      options({ retryPolicy: never() }),
    );

    const handle = await resonate.invokeLocal<void>("res", "res.0");
    await handle.result();
    expect(arr).toEqual([1, 2, 3, 4]);
  });

  test("Finalizers are called in the presence of errors", async () => {
    const resonate = new Resonate();

    const arr: number[] = [];
    resonate.register(
      "res",
      async (ctx: Context) => {
        ctx.setResource("4", 4, async () => {
          arr.push(4);
        });

        ctx.setResource("3", 3, async () => {
          arr.push(3);
        });

        ctx.setResource("2", 2, async () => {
          arr.push(2);
        });

        ctx.setResource("1", 1, async () => {
          arr.push(1);
        });

        throw new Error("Some Error");
      },
      options({ retryPolicy: never() }),
    );

    const handle = await resonate.invokeLocal<void>("res", "res.0");
    await expect(handle.result()).rejects.toThrow("Some Error");
    expect(arr).toEqual([1, 2, 3, 4]);
  });

  test("Finalizers are called in the presence of unrecoverable errors", async () => {
    const resonate = new Resonate();

    const arr: number[] = [];
    resonate.register(
      "res",
      async (ctx: Context) => {
        ctx.setResource("4", 4, async () => {
          arr.push(4);
        });

        ctx.setResource("3", 3, async () => {
          arr.push(3);
        });

        ctx.setResource("2", 2, async () => {
          arr.push(2);
        });

        ctx.setResource("1", 1, async () => {
          arr.push(1);
        });

        jest
          .spyOn(resonate.store.promises, "resolve")
          .mockRejectedValue(new ResonateError("Fetch Error", ErrorCodes.FETCH, "mock", true));
      },
      options({ retryPolicy: never() }),
    );

    const handle = await resonate.invokeLocal<void>("res", "res.0");
    const durablePromise = await resonate.store.promises.get(handle.invocationId);
    expect(durablePromise.state).toBe("PENDING");
    try {
      await handle.result();
    } catch (err) {
      if (err instanceof ResonateError) {
        expect(err.code).toBe(ErrorCodes.ABORT);
      } else {
        fail("expected Resonate Error");
      }
    }
    expect(arr).toEqual([1, 2, 3, 4]);
  });

  test("Error thrown is the user error and not the setResource Error", async () => {
    const resonate = new Resonate();

    resonate.register(
      "res",
      async (ctx: Context) => {
        ctx.setResource("myResource", "resource");
        throw new Error("Some Error");
      },
      options({ retryPolicy: linear(10, 3) }),
    );

    const handle = await resonate.invokeLocal<void>("res", "res.0");
    try {
      await handle.result();
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toEqual("Some Error");
    }
  });
});
