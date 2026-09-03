import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { AsyncHeartbeat } from "../src/heartbeat.js";
import type { Logger } from "../src/logger.js";
import type { Request, Response } from "../src/network/types.js";
import type { Send } from "../src/types.js";
import { VERSION } from "../src/util.js";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("AsyncHeartbeat", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("sends the tracked task reference instead of an empty batch", async () => {
    jest.useFakeTimers();
    const requests: Request[] = [];
    const send = (async (req: Request) => {
      requests.push(req);
      return {
        kind: req.kind,
        head: { corrId: req.head.corrId, status: 200, version: VERSION },
        data: {},
      } as any;
    }) as unknown as Send;
    const heartbeat = new AsyncHeartbeat("worker", 100, send, logger);

    heartbeat.start({ id: "workflow:0", version: 3 });
    await jest.advanceTimersByTimeAsync(100);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "task.heartbeat",
      data: {
        pid: "worker",
        tasks: [{ id: "workflow:0", version: 3 }],
      },
    });

    heartbeat.stop({ id: "workflow:0", version: 3 });
    await jest.advanceTimersByTimeAsync(100);
    expect(requests).toHaveLength(1);
  });

  test("does not start a heartbeat without an acquired task", async () => {
    jest.useFakeTimers();
    const send = jest.fn(async (_req: Request) => ({}) as Response) as unknown as Send;
    const heartbeat = new AsyncHeartbeat("worker", 100, send, logger);

    heartbeat.start();
    await jest.advanceTimersByTimeAsync(1000);

    expect(send).not.toHaveBeenCalled();
    heartbeat.stop();
  });
});
