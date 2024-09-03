import { describe, test, expect, jest, beforeAll, afterAll } from "@jest/globals";
import { Resonate, Context } from "../lib/resonate";

// This config is per test not global execution of this test suite
jest.setTimeout(10000);

describe("Sleep", () => {
  const resonates: Resonate[] = [new Resonate()];

  if (process.env.RESONATE_STORE_URL && process.env.RESONATE_TASK_SOURCE_URL) {
    // Push an instance of resonate that connects to the remote server
    resonates.push(
      new Resonate({
        url: process.env.RESONATE_STORE_URL,
        tasksUrl: process.env.RESONATE_TASK_SOURCE_URL,
      }),
    );
  }

  for (const resonate of resonates) {
    describe(resonate.store.constructor.name, () => {
      const timestamp = Date.now();
      const funcId = `sleep-${timestamp}`;
      resonate.register(funcId, async (ctx: Context, ms: number) => {
        const t1 = Date.now();
        await ctx.sleep(ms);
        const t2 = Date.now();

        return t2 - t1;
      });

      beforeAll(() => {
        return resonate.start();
      });

      afterAll(() => {
        return resonate.stop();
      });

      for (const ms of [20, 10, 100, 500]) {
        test(`Sleep ${ms}ms`, () => {
          return expect(resonate.run(funcId, `${funcId}-${ms}`, ms)).resolves.toBeGreaterThanOrEqual(ms);
        });
      }
    });
  }
});
