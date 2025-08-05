import type { RequestMsg } from "../src/network/network";
import { ServerProcess } from "./server";
import { Message, Random, Simulator, unicast } from "./simulator";
import { WorkerProcess } from "./worker";

import type * as context from "../src/context";

// --- Command-line argument parsing ---
const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error("Usage: bun sim/main.ts --seed <number> --ticks <number>");
  process.exit(1);
}

function getArgValue(name: string): string {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) {
    console.error(`Missing value for ${name}`);
    console.error("Usage: bun sim/main.ts --seed <number> --ticks <number>");
    process.exit(1);
  }
  return argv[index + 1];
}

// Parse required --seed and --ticks flags
const seedArg = getArgValue("--seed");
const ticksArg = getArgValue("--ticks");

const seed = Number.parseInt(seedArg, 10);
if (Number.isNaN(seed)) {
  console.error(`Invalid seed: ${seedArg}`);
  process.exit(1);
}

const ticks = Number.parseInt(ticksArg, 10);
if (Number.isNaN(ticks) || ticks < 0) {
  console.error(`Invalid ticks: ${ticksArg}`);
  process.exit(1);
}

console.log("seed:", seed);
console.log("ticks:", ticks);

function* fib(ctx: context.Context, n: number): Generator {
  if (n <= 1) {
    return n;
  }

  return (yield ctx.rpc("fib", n - 1)) + (yield ctx.run(fib, n - 2));
}

const rnd = new Random(seed);
const sim = new Simulator(seed, { randomDelay: rnd.next(), duplProb: rnd.next(), dropProb: rnd.next() });

const server = new ServerProcess("server");
const worker1 = new WorkerProcess("worker-1", "default");
const worker2 = new WorkerProcess("worker-2", "default");
const worker3 = new WorkerProcess("worker-3", "default");

worker1.resonate.register("fib", fib);
worker2.resonate.register("fib", fib);
worker3.resonate.register("fib", fib);

sim.register(server);
sim.register(worker1);
sim.register(worker2);
sim.register(worker3);

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
while (i < ticks) {
  sim.tick();
  i++;
}

console.log("outbox", sim.outbox);
