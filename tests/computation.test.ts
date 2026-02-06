import { WallClock } from "../src/clock.js";
import { Computation, type Status } from "../src/computation.js";
import type { Context, InnerContext } from "../src/context.js";
import type { ClaimedTask } from "../src/core.js";
import { JsonEncoder } from "../src/encoder.js";
import { NoopEncryptor } from "../src/encryptor.js";
import { Handler } from "../src/handler.js";
import { NoopHeartbeat } from "../src/heartbeat.js";
import { LocalNetwork } from "../src/network/local.js";
import type { PromiseRecord, TaskRecord } from "../src/network/types.js";
import { OptionsBuilder } from "../src/options.js";
import type { Processor } from "../src/processor/processor.js";
import { Registry } from "../src/registry.js";
import { NoopSpan, NoopTracer } from "../src/tracer.js";
import type { Result } from "../src/types.js";
import * as util from "../src/util.js";

async function createPromiseAndTask(
  handler: Handler,
  id: string,
  funcName: string,
  args: any[],
): Promise<{ promise: PromiseRecord; task: TaskRecord }> {
  return new Promise((resolve) => {
    handler.taskCreate(
      {
        kind: "task.create",
        head: { corrId: "", version: "" },
        data: {
          pid: "default",
          ttl: 5 * util.MIN,
          action: {
            kind: "promise.create",
            head: { corrId: "", version: "" },
            data: {
              id: id,
              timeoutAt: 24 * util.HOUR + Date.now(),
              param: {
                headers: {},
                data: {
                  func: funcName,
                  args: args,
                  version: 1,
                },
              },
              tags: { "resonate:target": "poll://any@default/default" },
            },
          },
        },
      },
      (res) => {
        util.assert(res.kind === "value");
        resolve({ promise: res.value.promise, task: res.value.task! });
      },
    );
  });
}

// A captured task waiting to be completed
interface PendingTodo {
  id: string;
  func: () => Promise<any>;
  callback: (res: Result<any, any>) => void;
}

// This mock allows us to control when "async" tasks complete.
class MockProcessor implements Processor {
  public pendingTodos: Map<string, PendingTodo> = new Map();
  private todoNotifier?: { expectedCount: number; resolve: () => void };
  private results: Map<string, Result<any, any>> = new Map();
  private waiter: { ids: Set<string>; cb: (results: { id: string; result: Result<any, any> }[]) => void } | null = null;

  process(work: { id: string; ctx: InnerContext; func: () => Promise<any>; span: any; verbose: boolean }[]): void {
    for (const item of work) {
      if (this.pendingTodos.has(item.id)) continue;
      this.pendingTodos.set(item.id, {
        id: item.id,
        func: item.func,
        callback: (res) => {
          this.results.set(item.id, res);
          this.notifyWaiter(item.id);
        },
      });

      if (this.todoNotifier && this.pendingTodos.size >= this.todoNotifier.expectedCount) {
        this.todoNotifier.resolve();
        this.todoNotifier = undefined;
      }
    }
  }

  getReady(ids: string[], cb: (results: { id: string; result: Result<any, any> }[]) => void): void {
    const ready: { id: string; result: Result<any, any> }[] = [];
    const idsSet = new Set(ids);
    for (const id of ids) {
      if (this.results.has(id)) {
        ready.push({ id, result: this.results.get(id)! });
        idsSet.delete(id);
      }
    }
    if (ready.length > 0) {
      cb(ready);
      return;
    }
    this.waiter = { ids: idsSet, cb };
  }

  private notifyWaiter(completedId: string): void {
    if (!this.waiter || !this.waiter.ids.has(completedId)) return;
    const ready: { id: string; result: Result<any, any> }[] = [];
    for (const id of this.waiter.ids) {
      if (this.results.has(id)) {
        ready.push({ id, result: this.results.get(id)! });
      }
    }
    const cb = this.waiter.cb;
    this.waiter = null;
    if (ready.length > 0) cb(ready);
  }

  async waitForTasks(count: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.pendingTodos.size >= count) return resolve();
      this.todoNotifier = { expectedCount: count, resolve };
    });
  }

  async completeAll() {
    const todosToComplete = [...this.pendingTodos.values()];
    this.pendingTodos.clear();
    for (const todo of todosToComplete) {
      todo.callback({ kind: "value", value: `completed-${todo.id}` });
    }
  }
}

describe("Computation Event Queue Concurrency", () => {
  let mockProcessor: MockProcessor;
  let network: LocalNetwork;
  let handler: Handler;
  let registry: Registry;
  let computation: Computation;

  // const processSpy = jest.spyOn(Computation.prototype as any, "_process");

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessor = new MockProcessor();
    network = new LocalNetwork({ pid: "test-pid", group: "test-group" });
    handler = new Handler(network, new JsonEncoder(), new NoopEncryptor());
    registry = new Registry();
    const messsageSource = network.getMessageSource();

    computation = new Computation(
      "root-promise-1",
      new WallClock(),
      network,
      handler,
      new Map(),
      registry,
      new NoopHeartbeat(),
      new Map(),
      new OptionsBuilder({ match: messsageSource.match, idPrefix: "" }),
      false,
      new NoopTracer(),
      new NoopSpan(),
      mockProcessor,
    );
  });

  test("should process all events serially even when they complete concurrently", async () => {
    function* testCoroutine(ctx: Context) {
      const fa = yield* ctx.beginRun(() => "this-value-wont-be-used");
      const fb = yield* ctx.beginRun(() => "this-value-wont-be-used");
      const fc = yield* ctx.beginRun(() => "this-value-wont-be-used");
      const fd = yield* ctx.beginRun(() => "this-value-wont-be-used");
      const va = yield* fa;
      const vb = yield* fb;
      const vc = yield* fc;
      const vd = yield* fd;
      return { a: va, b: vb, c: vc, d: vd };
    }

    registry.add(testCoroutine, "testCoro");
    const { promise, task } = await createPromiseAndTask(handler, "root-promise-1", "testCoro", []);

    // Acquire the task on the server so task.fulfill can succeed
    await new Promise<void>((resolve) => {
      network.send(
        {
          kind: "task.acquire",
          head: { corrId: "", version: "" },
          data: { id: task.id, version: task.version, pid: "test-pid", ttl: 3600 },
        },
        () => resolve(),
      );
    });

    const testTask: ClaimedTask = {
      kind: "claimed",
      task: task,
      rootPromise: promise,
    };

    const computationPromise: Promise<Status> = new Promise((resolve) => {
      computation.executeUntilBlocked(testTask, (res) => {
        if (res.kind === "error") {
          throw new Error("Computation processing failed");
        }

        resolve(res.value);
      });
    });

    await mockProcessor.waitForTasks(4);
    // At this point, doRun has been called once for the initial "invoke"
    // expect(processSpy).toHaveBeenCalledTimes(1);
    expect(mockProcessor.pendingTodos.size).toBe(4);

    // Trigger concurrent completion
    await mockProcessor.completeAll();

    const result = await computationPromise;

    // Check that `doRun` was called correctly.
    // - 1st call: Initial 'invoke'
    // - 2nd call: For the fa 'return' event.
    // - 3rd call: For the fb 'return' event.
    // - 4th call: For the fc 'return' event.
    // - 5th call: For the fd 'return' event.
    // expect(processSpy).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({
      kind: "completed",
      promise: {
        value: {
          data: {
            a: "completed-root-promise-1.0",
            b: "completed-root-promise-1.1",
            c: "completed-root-promise-1.2",
            d: "completed-root-promise-1.3",
          },
        },
      },
    });
  });
});
