import { StepClock } from "../src/clock.js";
import type * as context from "../src/context.js";
import { JsonEncoder } from "../src/encoder.js";
import type { Request } from "../src/network/types.js";
import { Registry } from "../src/registry.js";
import * as util from "../src/util.js";
import { ServerProcess } from "./src/server.js";
import { Message, Random, Simulator, unicast } from "./src/simulator.js";
import { WorkerProcess } from "./src/worker.js";

// Define a resonate function
function* fibonacci(ctx: context.Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const p1 = yield ctx.beginRun(fibonacci, n - 1);
  const p2 = yield ctx.beginRun(fibonacci, n - 2);

  return (yield p1) + (yield p2);
}

const options = { seed: 0, steps: 100000, randomDelay: 0.8, dropProb: 0, duplProb: 0, charFlipProb: 0 };

const rnd = new Random(options.seed);
const clock = new StepClock();
const encoder = new JsonEncoder();
const registry = new Registry();
registry.add(fibonacci);

const sim = new Simulator(rnd, {
  randomDelay: options.randomDelay,
  dropProb: options.dropProb,
  duplProb: options.duplProb,
});

const server = new ServerProcess(clock, "server");
const worker1 = new WorkerProcess(
  rnd,
  clock,
  encoder,
  registry,
  { charFlipProb: options.charFlipProb },
  "worker-1",
  "default",
);
const worker2 = new WorkerProcess(
  rnd,
  clock,
  encoder,
  registry,
  { charFlipProb: options.charFlipProb },
  "worker-2",
  "default",
);
const worker3 = new WorkerProcess(
  rnd,
  clock,
  encoder,
  registry,
  { charFlipProb: options.charFlipProb },
  "worker-3",
  "default",
);

const workers = [worker1, worker2, worker3] as const;

sim.register(server);
for (const worker of workers) {
  sim.register(worker);
}

const n = 10;
const id = `fibonacci-${n}`;

sim.delay(0, () => {
  sim.send(
    new Message<Request>(
      unicast("environment"),
      unicast("server"),
      {
        kind: "promise.create",
        head: { corrId: "", version: "" },
        data: {
          id,
          timeoutAt: 10000000,
          tags: { "resonate:target": "sim://any@default" },
          param: encoder.encode({ func: "fibonacci", args: [n], version: 1 }),
        },
      },
      { requ: true, correlationId: 1 },
    ),
  );
});

function f(n: number, memo: Record<number, number> = {}): number {
  if (n <= 1) return n;

  if (memo[n] !== undefined) {
    return memo[n];
  }

  memo[n] = f(n - 1, memo) + f(n - 2, memo);
  return memo[n];
}

const result = sim.execUntil(options.steps, () => {
  const promise = server.server.promises.get(id);
  const value = promise?.value;
  const valueWithHeaders = value ? { headers: value.headers || {}, data: value.data || "" } : undefined;
  return !!valueWithHeaders && encoder.decode(valueWithHeaders) === f(n);
});

util.assert(result);
