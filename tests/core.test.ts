import { describe, expect, jest, test } from "@jest/globals";
import { WallClock } from "../src/clock.js";
import type { Status } from "../src/computation.js";
import type { ClaimedTask } from "../src/core.js";
import { Core } from "../src/core.js";
import { JsonEncoder } from "../src/encoder.js";
import { NoopEncryptor } from "../src/encryptor.js";
import { Handler } from "../src/handler.js";
import type { Heartbeat } from "../src/heartbeat.js";
import { LocalNetwork } from "../src/network/local.js";
import type { PromiseRecord, Request, TaskRecord } from "../src/network/types.js";
import { OptionsBuilder } from "../src/options.js";
import { Registry } from "../src/registry.js";
import { NoopSpan, NoopTracer } from "../src/tracer.js";
import type { Result } from "../src/types.js";

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

  executeUntilBlocked(
    task: ClaimedTask | { kind: "unclaimed"; task: TaskRecord },
    done: (res: Result<Status, undefined>) => void,
  ) {
    this.calls.push(task as ClaimedTask);
    const res = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    done(res);
  }
}

function buildCore(opts: { responses: Result<Status, undefined>[]; mockRef?: { mock: MockComputation } }): {
  core: Core;
  network: LocalNetwork;
  handler: Handler;
  ctorSpy: jest.Spied<any>;
} {
  const network = new LocalNetwork();
  const encoder = new JsonEncoder();
  const encryptor = new NoopEncryptor();
  const handler = new Handler(network, encoder, encryptor);

  const activeMock = new MockComputation(opts.responses);
  if (opts.mockRef) {
    opts.mockRef.mock = activeMock;
  }

  const core = new Core({
    pid: "test-pid",
    ttl: 60_000,
    clock: new WallClock(),
    network,
    handler,
    tracer: new NoopTracer(),
    registry: new Registry(),
    heartbeat: new TestHeartbeat(),
    dependencies: new Map(),
    optsBuilder: new OptionsBuilder({ match: (t: string) => t, idPrefix: "test-" }),
    verbose: false,
  });

  const ctorSpy = jest.spyOn(core as any, "createComputation").mockReturnValue(activeMock);

  return { core, network, handler, ctorSpy };
}

function wrapCb<T>(): { promise: Promise<T>; cb: (val: T) => void } {
  let resolve: (val: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, cb: (val: T) => resolve(val) };
}

function wrapVoidCb(): { promise: Promise<void>; cb: () => void } {
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, cb: () => resolve() };
}

function seedAcquiredTask(
  network: LocalNetwork,
  handler: Handler,
  id: string,
  func: string,
  args: any[],
): Promise<{ task: TaskRecord; rootPromise: PromiseRecord }> {
  return new Promise((resolve, reject) => {
    const encoder = new JsonEncoder();
    const param = encoder.encode({ func, args, version: 1 });

    handler.taskCreate(
      {
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
              param,
              tags: { "resonate:target": "default" },
              timeoutAt: Date.now() + 60_000,
            },
          },
        },
      },
      (res) => {
        if (res.kind === "error") {
          reject(res.error);
          return;
        }
        const createdTask = res.value.task!;
        handler.taskAcquire(
          {
            kind: "task.acquire",
            head: { corrId: "", version: "" },
            data: { id: createdTask.id, version: createdTask.version, pid: "test-pid", ttl: 60_000 },
          },
          (acquireRes) => {
            if (acquireRes.kind === "error") {
              reject(acquireRes.error);
            } else {
              resolve({ task: acquireRes.value.task, rootPromise: acquireRes.value.root });
            }
          },
        );
      },
    );
  });
}

async function seedPendingTask(
  network: LocalNetwork,
  handler: Handler,
  id: string,
  func: string,
  args: any[],
): Promise<TaskRecord> {
  const { task } = await seedAcquiredTask(network, handler, id, func, args);
  return new Promise((resolve, reject) => {
    network.send(
      {
        kind: "task.release",
        head: { corrId: "", version: "" },
        data: { id: task.id, version: task.version },
      },
      (res) => {
        if (res.head.status === 200) {
          const serverTask = (network as any).server?.tasks?.get(task.id);
          resolve({ id: task.id, state: "pending", version: serverTask?.version ?? task.version + 1 });
        } else {
          reject(new Error(`Failed to release task: ${res.head.status}`));
        }
      },
    );
  });
}

function interceptNetwork(network: LocalNetwork): { sent: Request[] } {
  const sent: Request[] = [];
  const origSend = network.send.bind(network);
  network.send = ((req: any, cb: any, ...rest: any[]) => {
    sent.push(req);
    return origSend(req, cb, ...rest);
  }) as typeof network.send;
  return { sent };
}

describe("Core", () => {
  describe("executeUntilBlocked", () => {
    test("computation resolves - sends task.fulfill with resolved value", async () => {
      const { core, network, handler } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "p1", state: "resolved", value: 42 } }],
      });

      const { task, rootPromise } = await seedAcquiredTask(network, handler, "p1", "main", []);
      const { sent } = interceptNetwork(network);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const { promise, cb } = wrapCb<Result<Status, undefined>>();
      core.executeUntilBlocked(new NoopSpan(), claimed, cb);
      const res = await promise;

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
      const { core, network, handler } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "p2", state: "rejected", value: "err" } }],
      });

      const { task, rootPromise } = await seedAcquiredTask(network, handler, "p2", "main", []);
      const { sent } = interceptNetwork(network);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const { promise, cb } = wrapCb<Result<Status, undefined>>();
      core.executeUntilBlocked(new NoopSpan(), claimed, cb);
      const res = await promise;

      expect(res.kind).toBe("value");
      const fulfill = sent.find((r) => r.kind === "task.fulfill");
      expect(fulfill).toBeDefined();
      if (fulfill && fulfill.kind === "task.fulfill") {
        expect(fulfill.data.action.data.state).toBe("rejected");
      }
    });

    test("computation errors - sends task.release", async () => {
      const { core, network, handler } = buildCore({
        responses: [{ kind: "error", error: undefined }],
      });

      const { task, rootPromise } = await seedAcquiredTask(network, handler, "p3", "main", []);
      const { sent } = interceptNetwork(network);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const { promise, cb } = wrapCb<Result<Status, undefined>>();
      core.executeUntilBlocked(new NoopSpan(), claimed, cb);
      const res = await promise;

      expect(res.kind).toBe("error");
      const release = sent.find((r) => r.kind === "task.release");
      expect(release).toBeDefined();
    });

    test("computation suspends - sends task.suspend with awaited IDs", async () => {
      const { core, network, handler } = buildCore({
        responses: [{ kind: "value", value: { kind: "suspended", awaited: ["dep-a", "dep-b"] } }],
      });

      const { task, rootPromise } = await seedAcquiredTask(network, handler, "p4", "main", []);
      await seedAcquiredTask(network, handler, "dep-a", "depFunc", []);
      await seedAcquiredTask(network, handler, "dep-b", "depFunc", []);

      const { sent } = interceptNetwork(network);

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const { promise, cb } = wrapCb<Result<Status, undefined>>();
      core.executeUntilBlocked(new NoopSpan(), claimed, cb);
      const res = await promise;

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
      const { core, network, handler } = buildCore({
        responses: [
          { kind: "value", value: { kind: "suspended", awaited: ["dep-x"] } },
          { kind: "value", value: { kind: "done", id: "p5", state: "resolved", value: "final" } },
        ],
        mockRef,
      });

      const { task, rootPromise } = await seedAcquiredTask(network, handler, "p5", "main", []);
      await seedAcquiredTask(network, handler, "dep-x", "depFunc", []);

      const origSend = network.send.bind(network);
      network.send = ((req: any, cb: any, ...rest: any[]) => {
        if (req.kind === "task.suspend") {
          cb({
            kind: "task.suspend",
            head: { corrId: "", status: 300, version: "" },
            data: undefined,
          });
          return;
        }
        return origSend(req, cb, ...rest);
      }) as typeof network.send;

      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };
      const { promise, cb } = wrapCb<Result<Status, undefined>>();
      core.executeUntilBlocked(new NoopSpan(), claimed, cb);
      const res = await promise;

      expect(res.kind).toBe("value");
      if (res.kind === "value") {
        expect(res.value.kind).toBe("done");
      }
      expect(mockRef.mock.calls.length).toBe(2);
    });

    test("computation reused for same root promise ID", async () => {
      const { core, network, handler, ctorSpy } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "reuse-id", state: "resolved", value: 1 } }],
      });

      const { task, rootPromise } = await seedAcquiredTask(network, handler, "reuse-id", "main", []);
      const claimed: ClaimedTask = { kind: "claimed", task, rootPromise };

      const { promise: p1, cb: cb1 } = wrapCb<Result<Status, undefined>>();
      core.executeUntilBlocked(new NoopSpan(), claimed, cb1);
      await p1;

      const { promise: p2, cb: cb2 } = wrapCb<Result<Status, undefined>>();
      core.executeUntilBlocked(new NoopSpan(), claimed, cb2);
      await p2;

      expect(ctorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("onMessage", () => {
    test("acquires task then delegates to executeUntilBlocked", async () => {
      const mockRef = { mock: null as unknown as MockComputation };
      const { core, network, handler } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "on-msg-1", state: "resolved", value: "ok" } }],
        mockRef,
      });

      const task = await seedPendingTask(network, handler, "on-msg-1", "main", []);

      const { promise, cb } = wrapVoidCb();
      core.onMessage({ kind: "execute", head: {}, data: { task } }, cb);
      await promise;

      expect(mockRef.mock.calls.length).toBe(1);
      expect(mockRef.mock.calls[0].kind).toBe("claimed");
    });

    test("acquire failure (409) calls cb without hanging", async () => {
      const mockRef = { mock: null as unknown as MockComputation };
      const { core, network, handler } = buildCore({
        responses: [{ kind: "value", value: { kind: "done", id: "fail-acq", state: "resolved", value: 0 } }],
        mockRef,
      });

      const { task } = await seedAcquiredTask(network, handler, "fail-acq", "main", []);

      const { promise, cb } = wrapVoidCb();
      core.onMessage({ kind: "execute", head: {}, data: { task: { id: task.id, version: task.version } } }, cb);
      await promise;

      expect(mockRef.mock.calls.length).toBe(0);
    });

    test("fulfill encodes value via handler.encodeValue", async () => {
      const { core, network, handler } = buildCore({
        responses: [
          {
            kind: "value",
            value: { kind: "done", id: "encode-test", state: "resolved", value: { x: 1 } },
          },
        ],
      });

      const task = await seedPendingTask(network, handler, "encode-test", "main", []);
      const { sent } = interceptNetwork(network);

      const { promise, cb } = wrapVoidCb();
      core.onMessage({ kind: "execute", head: {}, data: { task } }, cb);
      await promise;

      const fulfill = sent.find((r) => r.kind === "task.fulfill");
      expect(fulfill).toBeDefined();
      if (fulfill && fulfill.kind === "task.fulfill") {
        expect(fulfill.data.action.data.value.data).toBeDefined();
        expect(typeof fulfill.data.action.data.value.data).toBe("string");
      }
    });
  });
});
