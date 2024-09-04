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

        return { actual: t2 - t1, expected: ms };
      });

      beforeAll(() => {
        return resonate.start();
      });

      afterAll(() => {
        return resonate.stop();
      });

      test(`Sleep several milliseconds`, async () => {
        const handles = [];
        // Keep this array ordered in descending order to make sure we just await the longest promises
        for (const ms of [2000, 1500, 1000, 500, 200]) {
          handles.push(await resonate.invokeLocal(funcId, `${funcId}-${ms}`, ms));
        }

        const results = await Promise.all(handles.map((handle) => handle.result()));
        for (const result of results) {
          const res = result as { actual: number; expected: number };
          expect(res.actual).toBeGreaterThanOrEqual(res.expected);
        }
      });
    });
  }
});
