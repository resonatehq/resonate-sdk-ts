import { Context } from "./context";
import { Coroutine, type LocalTodo, type RemoteTodo } from "./coroutine";
import { Handler } from "./handler";
import type { Network } from "./network/network";
import { AsyncProcessor, type Processor } from "./processor/processor";
import type { Registry } from "./registry";
import type { ClaimedTask, CompResult, Task } from "./types";
import * as util from "./util";

interface InvocationParams {
  fn: (ctx: Context, ...args: any[]) => any;
  args: any[];
}

type Event = "invoke" | "return";

export class Computation {
  private promiseId: string;
  private pid: string;
  private group: string;
  private ttl: number;
  private eventQueue: Event[] = [];
  private isProcessing = false;
  private network: Network;
  private registry: Registry;
  private handler: Handler;
  private processor: Processor;
  private seenTodos: Set<string>;
  private task?: Task;
  private callback?: (res: CompResult) => void;
  private invocationParams?: InvocationParams;

  constructor(
    promiseId: string,
    network: Network,
    registry: Registry,
    group: string,
    pid: string,
    ttl: number,
    processor?: Processor,
  ) {
    this.promiseId = promiseId;
    this.handler = new Handler(network);
    this.network = network;
    this.registry = registry;
    this.pid = pid;
    this.group = group;
    this.ttl = ttl;
    this.processor = processor ?? new AsyncProcessor();
    this.seenTodos = new Set();
  }

  process(task: Task, cb: (res: CompResult) => void): void {
    if (this.task) {
      cb({ kind: "failure", task });
      return;
    }

    util.assert(
      task.rootPromiseId === this.promiseId,
      "trying to execute a task in a computation for another root promise",
    );

    if (task.kind === "claimed") {
      this.processClaimed(task, cb);
    } else if (task.kind === "unclaimed") {
      this.network.send(
        {
          kind: "claimTask",
          id: task.id,
          counter: task.counter,
          processId: this.pid,
          ttl: this.ttl,
        },
        (_timeout, response) => {
          if (response.kind === "claimedtask") {
            const { root, leaf } = response.message.promises;
            util.assertDefined(root);
            if (leaf) {
              this.handler.updateCache(leaf.data);
            }
            this.processClaimed({ ...task, kind: "claimed", rootPromise: root.data }, cb);
          }
        },
      );
    }
  }

  private processClaimed(task: ClaimedTask, cb: (res: CompResult) => void) {
    util.assert(
      this.task === undefined,
      "Trying to work on a task while another task is in process for the same root promise id",
    );

    this.task = task;
    this.callback = cb;
    this.seenTodos.clear();
    this.eventQueue = [];
    this.isProcessing = false;
    this.handler.updateCache(task.rootPromise);
    const fn = this.registry.get(task.rootPromise.param?.fn ?? "");

    if (!fn) {
      // TODO(avillega): drop the task here and call the callback with an error
      console.warn("couldn't find fn in the registry");
      return;
    }

    if (!this.invocationParams) {
      this.invocationParams = {
        fn,
        args: task.rootPromise.param?.args ?? [],
      };
    }
    this.eventQueue.push("invoke");
    this.run();
  }

  private completeTask(result: CompResult) {
    util.assertDefined(this.task);
    this.network.send({ kind: "completeTask", id: this.task.id, counter: this.task.counter }, () => {
      // Once the task is completed reset the computation
      this.task = undefined;
      this.eventQueue = [];
      this.isProcessing = false;
      this.seenTodos.clear();
      this.callback?.(result);
      this.callback = undefined;
    });
  }

  private handleRemoteTodos(todos: RemoteTodo[]) {
    let createdCallbacks = 0;
    const totalCallbacks = todos.length;
    // reset the event queue, if we made it here it means that all localTodos were proccesed,
    // if there is anything else in the queue it is redundant work and we should clean it to
    // avoid races or problems due to concurrency
    this.eventQueue = [];

    for (const remoteTodo of todos) {
      const { id } = remoteTodo;
      this.handler.createCallback(
        id,
        this.promiseId,
        Number.MAX_SAFE_INTEGER, // TODO (avillega): use the promise timeout
        `poll://any@${this.group}/${this.pid}`,
        (result) => {
          if (result.kind === "promise") {
            this.isProcessing = false; // unset so this return can be processed
            this.eventQueue.push("return");
            this.run();
            return;
          }
          if (result.kind === "callback") {
            createdCallbacks++;
            if (createdCallbacks === totalCallbacks) {
              this.completeTask({ kind: "suspended", durablePromiseId: this.promiseId });
              return;
            }
          }
        },
      );
    }
  }

  private handleLocalTodos(todos: LocalTodo[]) {
    for (const localTodo of todos) {
      if (this.seenTodos.has(localTodo.id)) {
        continue;
      }
      this.seenTodos.add(localTodo.id);
      const { id, fn, ctx, args } = localTodo;
      this.processor.process(
        id,
        async () => {
          return await fn(ctx, ...args);
        },
        (result) => {
          const value = result.success ? result.data : result.error;
          // TODO (avillega): Need to do a rejection too instead of resolving with error
          this.handler.resolvePromise(id, value, (_) => {
            this.eventQueue.push("return");
            this.run();
          });
        },
      );
    }
  }

  private run(): void {
    // Guard against concurrent processing of todos
    if (this.isProcessing || this.eventQueue.length === 0) {
      return;
    }
    this.doRun();
  }

  private doRun(): void {
    util.assert(!this.isProcessing, "should not execute doRun concurrently");
    this.isProcessing = true;

    const event = this.eventQueue.shift();
    util.assertDefined(event);

    const { fn, args } = this.invocationParams!;

    if (!util.isGeneratorFunction(fn)) {
      this.processor.process(
        this.promiseId,
        async () => {
          return await fn(new Context(), ...args);
        },
        (result) => {
          if (result.success) {
            this.handler.resolvePromise(this.promiseId, result.data, (durablePromise) => {
              util.assertDefined(this.task);
              this.completeTask({ kind: "completed", durablePromise });
            });
          } else {
            // TODO(avillega): handle reject
          }
        },
      );
      return;
    }

    // Is generator function case
    Coroutine.exec(this.promiseId, fn, args, this.handler, (result) => {
      // it is safe to unset isProcessing at this point, there are three possible "result"
      // - the coroutine is completed: we will complete the durablepromise and there should be no more work to do
      // - there are local todos: We need to unset isProccessing so as results come back they retrigger the processing
      // - there are only remote todos:

      if (result.type === "completed") {
        this.handler.resolvePromise(this.promiseId, result.value, (durablePromise) => {
          util.assertDefined(this.task);
          this.completeTask({ kind: "completed", durablePromise });
        });
        // We don't need to retrigger a run there is no more work to do for this task
        return;
      }

      util.assert(
        result.localTodos.length > 0 || result.remoteTodos.length > 0,
        "There must be local todos or remote todos if the coroutine is suspended",
      );

      if (result.localTodos.length !== 0) {
        this.handleLocalTodos(result.localTodos);

        // This is the end of the coroutine callback, if we still have work to do we call run
        // After sending all the todos to the processor unset isProcessing so the proccessed todos can trigger another run
        this.isProcessing = false;
        if (this.eventQueue.length > 0) {
          this.run();
        }
      } else {
        this.handleRemoteTodos(result.remoteTodos);
      }
    });
  }
}
