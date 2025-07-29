import type { RequestMsg } from "../src/network/network";
import { ServerProcess } from "./server";
import { Message, Simulator, unicast } from "./simulator";
import { WorkerProcess } from "./worker";

const sim = new Simulator(102);
const worker = new WorkerProcess("worker-1", "worker");
worker.resonate.register("foo", () => {
  return "hello world";
});
sim.register(new ServerProcess("server"));
sim.register(worker);

sim.send(
  new Message<RequestMsg>(
    unicast("server"),
    {
      kind: "createPromise",
      id: "foo",
      timeout: 10020001,
      tags: { "resonate:invoke": "local://any@worker" },
      param: { data: { func: "foo", args: [] } },
    },
    { requ: true, replyTo: "environment", correlationId: 0 },
  ),
);

let i = 0;
while (sim.more() || i < 10) {
  sim.tick();
  i++;
}

console.log(sim.outbox);
