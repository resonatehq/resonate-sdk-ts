import { Command } from "commander";
import type * as context from "../src/context";
import type { RequestMsg } from "../src/network/network";
import { ServerProcess } from "./server";
import { Message, Random, Simulator, unicast } from "./simulator";
import { WorkerProcess } from "./worker";

const program = new Command();

program
  .name("sim")
  .description("Run the simulator with a given seed and steps")
  .requiredOption("--seed <number>", "Random seed", (value) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) {
      throw new Error(`Invalid seed: ${value}`);
    }
    return n;
  })
  .requiredOption("--steps <number>", "Number of steps", (value) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || n < 0) {
      throw new Error(`Invalid steps: ${value}`);
    }
    return n;
  });

program.parse(process.argv);

const options = program.opts<{ seed: number; steps: number }>();

const rnd = new Random(options.seed);

function* fib(ctx: context.Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }

  const ps: any[] = [];
  const vs: number[] = [];

  for (let i = 1; i < 3; i++) {
    const choice: string = rnd.pick(["lfi", "rfi", "lfc", "rfc"]);

    switch (choice) {
      case "lfi": {
        const p = yield ctx.lfi(fib, n - i, ctx.options({ id: `fib-${n - i}` }));
        ps.push(p);
        break;
      }
      case "rfi": {
        const p = yield ctx.rfi("fib", n - i, ctx.options({ id: `fib-${n - i}` }));
        ps.push(p);
        break;
      }
      case "lfc": {
        const v: number = yield ctx.lfc(fib, n - i, ctx.options({ id: `fib-${n - i}` }));
        vs.push(v);
        break;
      }
      case "rfc": {
        const v: number = yield ctx.rfc("fib", n - i, ctx.options({ id: `fib-${n - i}` }));
        vs.push(v);
        break;
      }
    }
  }

  for (const p of ps) {
    const v: number = yield p;
    vs.push(v);
  }

  if (vs.length !== 2) {
    throw new Error("Assertion failed: vs.length must be 2");
  }

  return vs[0] + vs[1];
}

const sim = new Simulator(options.seed, {
  randomDelay: rnd.random(0.5),
  dropProb: rnd.random(0.5),
  duplProb: rnd.random(0.5),
});

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

let i = 0;
while (i < options.steps) {
  const n = rnd.randint(0, 99);
  const timeout = rnd.randint(0, options.steps);
  const id = `${n}`;
  sim.send(
    new Message<RequestMsg>(
      unicast("environment"),
      unicast("server"),
      {
        kind: "createPromise",
        id: id,
        timeout: timeout,
        iKey: id,
        tags: { "resonate:invoke": "local://any@default" },
        param: { func: "fib", args: [n] },
      },
      { requ: true, correlationId: i },
    ),
  );

  sim.tick();
  i++;
}

console.log("outbox", sim.outbox);
