import { Computation } from "./computation";
import * as context from "./context";
import { LocalNetwork } from "./network/local";
import type { CreatePromiseAndTaskRes } from "./network/network";
import { HttpNetwork } from "./network/remote";

function* foo(ctx: context.Context) {
  const p = yield* context.lfi((ctx) => {
    const a = 24;
    const b = 24;
    return a + b;
  });

  const p2 = yield* context.lfi((ctx) => {
    return 39;
  });

  const p3 = yield* context.rfi((ctx) => {
    return 46;
  });

  const v1 = yield* p;
  const v2 = yield* p2;

  return v1 + v2;
}

const network = new HttpNetwork({});
network.onMessage = (msg) => {
  console.log({ msg });
  if (msg.type === "resume" || msg.type === "invoke") {
    // Computation.invokeUnclaimed(msg.task, registry, network);
  } else {
    // Get the subs handlers and complete them with the promise info
  }
};

// Computation.invoke(network, id, fn, args, opts, etc,
//     (durablePromise, task) => {when durable promise gets created so it can finally set the handler, if task can not be created, sub to the promise instead},
//     (err, result) => {when computation finishes executing and root durable promise is completed}
// )

const compu = new Computation(network);
network.send(
  {
    kind: "createPromiseAndTask",
    promise: {
      id: "foo.root",
      timeout: Number.MAX_SAFE_INTEGER,
      param: {
        fn: "foo",
        args: [],
      },
      tags: { "resonate:invoke": "default" },
    },
    task: {
      processId: "0",
      ttl: 300_000,
    },
    iKey: "foo.root",
    strict: false,
  },
  (_timeout, res) => {
    const { promise, task } = res as CreatePromiseAndTaskRes;
    if (promise.state === "resolved") {
      console.log("got result", promise.value!);
      return;
    }
    if (!task) {
      console.log("got no task, should create a sub for the promise instead");
      return;
    }
    compu.invoke(task!, { id: promise.id, fn: foo, args: [] }, (_err, result) => console.log("got result", result));
  },
);
