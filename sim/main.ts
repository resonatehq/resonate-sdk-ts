import type { RequestMsg } from "../src/network/network";
import { ServerProcess } from "./server";
import { Message, Simulator, unicast } from "./simulator";
import { WorkerProcess } from "./worker";

import type * as context from "../src/context";
function* fib(ctx: context.Context, n: number): Generator {
  if (n <= 1) {
    return n;
  }
  return (yield ctx.lfc(fib, n - 1)) + (yield ctx.lfc(fib, n - 2));
}

const sim = new Simulator(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
const worker = new WorkerProcess("worker-1");

worker.resonate.register("fib", fib);
sim.register(new ServerProcess());
sim.register(worker);

sim.send(
  new Message<RequestMsg>(
    unicast("environment"),
    unicast("server"),
    {
      kind: "createPromise",
      id: "foo",
      timeout: 10020001,
      iKey: "foo",
      tags: { "resonate:invoke": "local://any@worker" },
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

console.log(sim.outbox);
