import type { RequestMsg } from "../src/network/network";
import { ServerProcess } from "./server";
import { Message, Simulator, unicast } from "./simulator";
import { WorkerProcess } from "./worker";

import type * as context from "../src/context";
function* foo(ctx: context.Context, n: number): Generator {
  const v = yield* ctx.lfc(bar);
  return v;
}

function bar(ctx: context.Context): string {
  return "Hello, world";
}

const sim = new Simulator(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
const worker = new WorkerProcess("worker-1");

worker.resonate.register("foo", foo);
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
      param: { fn: "foo", args: [] },
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
