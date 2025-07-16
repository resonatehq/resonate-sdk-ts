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
  (timeout, res) => {
    const { promise, task } = res as CreatePromiseAndTaskRes;
    if (!task) {
      console.log("got no task, should create a sub for the promise instead");
    }
    compu.invoke(task!, { id: promise.id, fn: foo, args: [] }, (err, result) => console.log("got result", result));
  },
);
