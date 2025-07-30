import type { RequestMsg } from "../src/network/network";
import { ServerProcess } from "./server";
import { DeliveryOptions, Message, Simulator, unicast } from "./simulator";
import { WorkerProcess } from "./worker";

import type * as context from "../src/context";
function* fib(ctx: context.Context, n: number): Generator {
  if (n <= 1) {
    return n;
  }
  return (yield ctx.rpc("fib", n - 1)) + (yield ctx.rpc("fib", n - 2));
}

function* foo(ctx: context.Context): Generator {
  yield ctx.run(bar);
}
function* bar(ctx: context.Context): Generator {
  return;
}

const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
console.log("seed: ", seed);
const sim = new Simulator(seed, { randomDelay: 0.5, duplProb: 0.5 });
const server = new ServerProcess("server");
const worker1 = new WorkerProcess("worker-1", "default");

worker1.resonate.register("fib", fib);
worker1.resonate.register("foo", foo);

sim.register(server);
sim.register(worker1);

sim.send(
  new Message<RequestMsg>(
    unicast("environment"),
    unicast("server"),
    {
      kind: "createPromise",
      id: "foo",
      timeout: 10020001,
      iKey: "foo",
      tags: { "resonate:invoke": "local://any@default" },
      param: { fn: "foo", args: [] },
    },
    { requ: true, correlationId: 0 },
  ),
);
sim.send(
  new Message<RequestMsg>(
    unicast("environment"),
    unicast("server"),
    {
      kind: "createPromise",
      id: "fib",
      timeout: 10020001,
      iKey: "fib",
      tags: { "resonate:invoke": "local://any@default" },
      param: { fn: "fib", args: [10] },
    },
    { requ: true, correlationId: 0 },
  ),
);

let i = 0;
while (sim.more() || i < 10) {
  sim.tick();
  i++;
}

console.log("outbox", sim.outbox);
console.log("seed promise foo", server.server.promises.get("foo")?.state === "resolved");
console.log("seed promise fib", server.server.promises.get("fib")?.state === "resolved");
