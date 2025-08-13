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
  .option(
    "--steps <number>",
    "Number of steps",
    (value) => {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n) || n < 0) {
        throw new Error(`Invalid steps: ${value}`);
      }
      return n;
    },
    10_000,
  );

program.parse(process.argv);

const options = program.opts<{ seed: number; steps: number }>();

const rnd = new Random(options.seed);

function* fibLfi(ctx: context.Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const p1 = yield ctx.lfi(fibLfi, n - 1, ctx.options({ id: `fibLfi-${n - 1}` }));
  const p2 = yield ctx.lfi(fibLfi, n - 2, ctx.options({ id: `fibLfi-${n - 2}` }));

  return (yield p1) + (yield p2);
}
function* fibRfi(ctx: context.Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const p1 = yield ctx.rfi("fibRfi", n - 1, ctx.options({ id: `fibRfi-${n - 1}` }));
  const p2 = yield ctx.rfi("fibRfi", n - 2, ctx.options({ id: `fibRfi-${n - 2}` }));

  return (yield p1) + (yield p2);
}
function* fibLfc(ctx: context.Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const v1 = yield ctx.lfc(fibLfc, n - 1, ctx.options({ id: `fibLfc-${n - 1}` }));
  const v2 = yield ctx.lfc(fibLfc, n - 2, ctx.options({ id: `fibLfc-${n - 2}` }));
  return v1 + v2;
}
function* fibRfc(ctx: context.Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const v1 = yield ctx.rfc("fibRfc", n - 1, ctx.options({ id: `fibRfc-${n - 1}` }));
  const v2 = yield ctx.rfc("fibRfc", n - 2, ctx.options({ id: `fibRfc-${n - 2}` }));
  return v1 + v2;
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

const workers = [worker1, worker2, worker3] as const;

const registrations: [string, (...args: any[]) => any][] = [
  ["fibLfi", fibLfi],
  ["fibRfi", fibRfi],
  ["fibLfc", fibLfc],
  ["fibRfc", fibRfc],
];

for (const [name, func] of registrations) {
  for (const worker of workers) {
    worker.resonate.register(name, func);
  }
}

sim.register(server);
for (const worker of workers) {
  sim.register(worker);
}

let i = 0;
while (i < options.steps) {
  let msg: Message<RequestMsg>;
  switch (rnd.randint(0, 4)) {
    case 0: {
      msg = new Message<RequestMsg>(
        unicast("environment"),
        unicast("server"),
        {
          kind: "createPromise",
          id: `fibLfi-${i}`,
          timeout: rnd.randint(0, options.steps),
          iKey: `fibLfi-${i}`,
          tags: { "resonate:invoke": "local://any@default" },
          param: { func: "fibLfi", args: [rnd.randint(0, 99)] },
        },
        { requ: true, correlationId: i },
      );
      break;
    }
    case 1: {
      msg = new Message<RequestMsg>(
        unicast("environment"),
        unicast("server"),
        {
          kind: "createPromise",
          id: `fibRfi-${i}`,
          timeout: rnd.randint(0, options.steps),
          iKey: `fibRfi-${i}`,
          tags: { "resonate:invoke": "local://any@default" },
          param: { func: "fibRfi", args: [rnd.randint(0, 99)] },
        },
        { requ: true, correlationId: i },
      );
      break;
    }
    case 2: {
      msg = new Message<RequestMsg>(
        unicast("environment"),
        unicast("server"),
        {
          kind: "createPromise",
          id: `fibLfc-${i}`,
          timeout: rnd.randint(0, options.steps),
          iKey: `fibLfc-${i}`,
          tags: { "resonate:invoke": "local://any@default" },
          param: { func: "fibLfc", args: [rnd.randint(0, 99)] },
        },
        { requ: true, correlationId: i },
      );
      break;
    }
    case 3: {
      msg = new Message<RequestMsg>(
        unicast("environment"),
        unicast("server"),
        {
          kind: "createPromise",
          id: `fibRfc-${i}`,
          timeout: rnd.randint(0, options.steps),
          iKey: `fibRfc-${i}`,
          tags: { "resonate:invoke": "local://any@default" },
          param: { func: "fibRfc", args: [rnd.randint(0, 99)] },
        },
        { requ: true, correlationId: i },
      );
      break;
    }
    case 4: {
      msg = new Message<RequestMsg>(
        unicast("environment"),
        unicast("server"),
        {
          kind: "createPromise",
          id: `fibCustom-${i}`,
          timeout: rnd.randint(0, options.steps),
          iKey: `fibCustom-${i}`,
          tags: { "resonate:invoke": "local://any@default" },
          param: { func: "fibCustom", args: [rnd.randint(0, 99)] },
        },
        { requ: true, correlationId: i },
      );
      break;
    }
    default: {
      throw new Error("not impleted");
    }
  }

  sim.send(msg);

  sim.tick();
  i++;
}

console.log("outbox", sim.outbox);
