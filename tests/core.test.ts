import { describe, expect, jest, test } from "@jest/globals";
import { WallClock } from "../src/clock.js";
import { Codec } from "../src/codec.js";
import type { Status } from "../src/computation.js";
import type { ClaimedTask } from "../src/core.js";
import { Core } from "../src/core.js";
import type { Heartbeat } from "../src/heartbeat.js";
import { LocalNetwork } from "../src/network/local.js";
import type { PromiseRecord, Request, TaskRecord } from "../src/network/types.js";
import { isSuccess } from "../src/network/types.js";
import { OptionsBuilder } from "../src/options.js";
import { Registry } from "../src/registry.js";
import type { Result, Send } from "../src/types.js";
import { buildTransport } from "../src/util.js";

class TestHeartbeat implements Heartbeat {
  start(): void {}
  stop(): void {}
}

class MockComputation {
  public calls: ClaimedTask[] = [];
  private responses: Result<Status, undefined>[];
  private callIndex = 0;

  constructor(responses: Result<Status, undefined>[]) {
    this.responses = responses;
  }

  executeUntilBlocked(task: ClaimedTask | { kind: "unclaimed"; task: TaskRecord }): Promise<Result<Status, undefined>> {
    this.calls.push(task as ClaimedTask);
    const res = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return Promise.resolve(res);
  }
}

function buildCore(opts: { responses: Result<Status, undefined>[]; mockRef?: { mock: MockComputation } }): {
  core: Core;
  network: LocalNetwork;
  sendHolder: { fn: Send };
  codec: Codec;
  ctorSpy: jest.Spied<any>;
} {
  const network = new LocalNetwork();
  const codec = new Codec();
  const transport = buildTransport(network);

  // Mutable holder so interceptSend can swap the inner function
  const sendHolder = { fn: transport.send };
  const proxiedSend: Send = (req: any) => sendHolder.fn(req);

  const activeMock = new MockComputation(opts.responses);
  if (opts.mockRef) {
    opts.mockRef.mock = activeMock;
  }

  const core = new Core({
    pid: "test-pid",
    ttl: 60_000,
    clock: new WallClock(),
    send: proxiedSend,
    codec,
    registry: new Registry(),
    heartbeat: new TestHeartbeat(),
    dependencies: new Map(),
    optsBuilder: new OptionsBuilder({ match: (t: string) => t, idPrefix: "test-" }),
    verbose: false,
  });

  const ctorSpy = jest.spyOn(core as any, "createComputation").mockReturnValue(activeMock);

  return { core, network, sendHolder, codec, ctorSpy };
}

async function seedAcquiredTask(
  send: Send,
  codec: Codec,
  id: string,
  func: string,
  args: any[],
): Promise<{ task: TaskRecord; rootPromise: PromiseRecord }> {
  const encodeResult = codec.encode({ func, args, version: 1 });
  if (encodeResult.kind === "error") {
    throw encodeResult.error;
  }

  const sendResult = await send({
    kind: "task.create",
    head: { corrId: "", version: "" },
    data: {
      pid: "test-pid",
      ttl: 60_000,
      action: {
        kind: "promise.create",
        head: { corrId: "", version: "" },
        data: {
          id,
          param: encodeResult.value,
          tags: { "resonate:target": "default" },
          timeoutAt: Date.now() + 60_000,
        },
      },
    },
  });
  if (sendResult.kind === "error") {
    throw sendResult.error;
  }
  const res = sendResult.value;
  if (!isSuccess(res)) {
    throw new Error(`Failed to create task: ${res.head.status}`);
  }
  const decodeResult = codec.decodePromise(res.data.promise);
  if (decodeResult.kind === "error") {
    throw decodeResult.error;
  }
  return { task: res.data.task, rootPromise: decodeResult.value };
}

async function seedPendingTask(
  send: Send,
  codec: Codec,
  id: string,
  func: string,
  args: any[],
  network: LocalNetwork,
): Promise<TaskRecord> {
  const { task } = await seedAcquiredTask(send, codec, id, func, args);
  const releaseResult = await send({
    kind: "task.release",
    head: { corrId: "", version: "" },
    data: { id: task.id, version: task.version },
  });
  if (releaseResult.kind === "error") {
    throw releaseResult.error;
  }
  if (releaseResult.value.head.status !== 200) {
    throw new Error(`Failed to release task: ${releaseResult.value.head.status}`);
  }
  const serverTask = (network as any).server?.tasks?.get(task.id);
  return { id: task.id, state: "pending", version: serverTask?.version ?? task.version + 1 };
}

function interceptSend(sendHolder: { fn: Send }): { sent: Request[] } {
  const sent: Request[] = [];
  const origSend = sendHolder.fn;
  sendHolder.fn = ((req: any) => {
    sent.push(req);
    return origSend(req);
  }) as Send;
  return { sent };
}

describe("Core", () => {
  describe("executeUntilBlocked", () => {
    test("computation resolves - sends task.fulfill with resolved value", async () => {
      const { core, sendHolder, codec } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "p1", state: "resolved", value: 42 } }],
      });

      const { task, rootPromise } = await seedAcquiredTask(sendHolder.fn, codec, "p1", "main", []);
      const { sent } = interceptSend(sendHolder);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const res = await core.executeUntilBlocked(claimed);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
      }

      const fulfill = sent.find((r) => r.kind === "task.fulfill");
      expect(fulfill).toBeDefined();
      if (fulfill && fulfill.kind === "task.fulfill") {
        expect(fulfill.data.action.data.state).toBe("resolved");
      }
    });

    test("computation rejects - sends task.fulfill with rejected value", async () => {
      const { core, sendHolder, codec } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "p2", state: "rejected", value: "err" } }],
      });

      const { task, rootPromise } = await seedAcquiredTask(sendHolder.fn, codec, "p2", "main", []);
      const { sent } = interceptSend(sendHolder);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const res = await core.executeUntilBlocked(claimed);

      expect(res.kind).toBe("value");
      const fulfill = sent.find((r) => r.kind === "task.fulfill");
      expect(fulfill).toBeDefined();
      if (fulfill && fulfill.kind === "task.fulfill") {
        expect(fulfill.data.action.data.state).toBe("rejected");
      }
    });

    test("computation errors - sends task.release", async () => {
      const { core, sendHolder, codec } = buildCore({
        responses: [{ kind: "error", error: undefined }],
      });

      const { task, rootPromise } = await seedAcquiredTask(sendHolder.fn, codec, "p3", "main", []);
      const { sent } = interceptSend(sendHolder);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const res = await core.executeUntilBlocked(claimed);

      expect(res.kind).toBe("error");
      const release = sent.find((r) => r.kind === "task.release");
      expect(release).toBeDefined();
    });

    test("computation suspends - sends task.suspend with awaited IDs", async () => {
      const { core, sendHolder, codec } = buildCore({
        responses: [{ kind: "value", value: { kind: "suspended", awaited: ["dep-a", "dep-b"] } }],
      });

      const { task, rootPromise } = await seedAcquiredTask(sendHolder.fn, codec, "p4", "main", []);
      await seedAcquiredTask(sendHolder.fn, codec, "dep-a", "depFunc", []);
      await seedAcquiredTask(sendHolder.fn, codec, "dep-b", "depFunc", []);

      const { sent } = interceptSend(sendHolder);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const res = await core.executeUntilBlocked(claimed);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("suspended");
      }

      const suspend = sent.find((r) => r.kind === "task.suspend");
      expect(suspend).toBeDefined();
      if (suspend && suspend.kind === "task.suspend") {
        const awaitedIds = suspend.data.actions.map((a) => a.data.awaited);
        expect(awaitedIds).toContain("dep-a");
        expect(awaitedIds).toContain("dep-b");
      }
    });

    test("computation suspends with redirect (continue) - re-executes", async () => {
      const mockRef = { mock: null as unknown as MockComputation };
      const { core, sendHolder, codec } = buildCore({
        responses: [
          { kind: "value", value: { kind: "suspended", awaited: ["dep-x"] } },
          { kind: "value", value: { kind: "done", id: "p5", state: "resolved", value: "final" } },
        ],
        mockRef,
      });

      const { task, rootPromise } = await seedAcquiredTask(sendHolder.fn, codec, "p5", "main", []);
      await seedAcquiredTask(sendHolder.fn, codec, "dep-x", "depFunc", []);

      const origFn = sendHolder.fn;
      sendHolder.fn = ((req: any) => {
        if (req.kind === "task.suspend") {
          return Promise.resolve({
            kind: "value",
            value: {
              kind: "task.suspend",
              head: { corrId: "", status: 300, version: "" },
              data: { preload: [] },
            },
          });
        }
        return origFn(req);
      }) as Send;

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const res = await core.executeUntilBlocked(claimed);

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
      }
      expect(mockRef.mock.calls.length).toBe(2);
    });
  });

  describe("onMessage", () => {
    test("acquires task then delegates to executeUntilBlocked", async () => {
      const mockRef = { mock: null as unknown as MockComputation };
      const { core, network, sendHolder, codec } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "on-msg-1", state: "resolved", value: "ok" } }],
        mockRef,
      });

      const task = await seedPendingTask(sendHolder.fn, codec, "on-msg-1", "main", [], network);

      await core.onMessage({ kind: "execute", head: {}, data: { task } });

      expect(mockRef.mock.calls.length).toBe(1);
      expect(mockRef.mock.calls[0].kind).toBe("claimed");
    });

    test("acquire failure (409) calls cb without hanging", async () => {
      const mockRef = { mock: null as unknown as MockComputation };
      const { core, sendHolder, codec } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "fail-acq", state: "resolved", value: 0 } }],
        mockRef,
      });

      const { task } = await seedAcquiredTask(sendHolder.fn, codec, "fail-acq", "main", []);

      await core.onMessage({ kind: "execute", head: {}, data: { task: { id: task.id, version: task.version } } });

      expect(mockRef.mock.calls.length).toBe(0);
    });

    test("fulfill encodes value via handler.encodeValue", async () => {
      const { core, network, sendHolder, codec } = buildCore({
        responses: [
          {
            kind: "value",
            value: { kind: "done", id: "encode-test", state: "resolved", value: { x: 1 } },
          },
        ],
      });

      const task = await seedPendingTask(sendHolder.fn, codec, "encode-test", "main", [], network);
      const { sent } = interceptSend(sendHolder);

      await core.onMessage({ kind: "execute", head: {}, data: { task } });

      const fulfill = sent.find((r) => r.kind === "task.fulfill");
      expect(fulfill).toBeDefined();
      if (fulfill && fulfill.kind === "task.fulfill") {
        expect(fulfill.data.action.data.value.data).toBeDefined();
        expect(typeof fulfill.data.action.data.value.data).toBe("string");
      }
    });
  });
});
