import { StepClock } from "../src/clock.js";
import { Codec } from "../src/codec.js";
import type { Context } from "../src/context.js";
import type { Request } from "../src/network/types.js";
import { Registry } from "../src/registry.js";
import { enableTrace, logTrace } from "../src/trace.js";
import { ServerProcess } from "./src/server.js";
import { Message, Random, Simulator, unicast } from "./src/simulator.js";
import { WorkerProcess } from "./src/worker.js";

function genId(n: number): string {
  return `fib-${n}`;
}

function* fibonacci(ctx: Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const p1 = yield ctx.beginRpc("fibonacci", n - 1, ctx.options({ id: genId(n - 1) }));
  const p2 = yield ctx.beginRpc(fibonacci, n - 2, ctx.options({ id: genId(n - 2) }));

  return (yield p1) + (yield p2);
}

const seed = Math.floor(Math.random() * 2 ** 32);

const options = { seed, steps: 1_000_000, randomDelay: 0, dropProb: 0, duplProb: 0, charFlipProb: 0 };

const rnd = new Random(options.seed);
const clock = new StepClock();
const codec = new Codec();
const registry = new Registry();
registry.add(fibonacci);

const sim = new Simulator(rnd, {
  randomDelay: options.randomDelay,
  dropProb: options.dropProb,
  duplProb: options.duplProb,
});

const server = new ServerProcess(clock, "server");
const worker1 = new WorkerProcess(rnd, clock, registry, { charFlipProb: options.charFlipProb }, "worker-1", "default");
const worker2 = new WorkerProcess(rnd, clock, registry, { charFlipProb: options.charFlipProb }, "worker-2", "default");
const worker3 = new WorkerProcess(rnd, clock, registry, { charFlipProb: options.charFlipProb }, "worker-3", "default");

sim.register(server);
for (const worker of [worker1, worker2, worker3]) {
  sim.register(worker);
}
const n = 10;

enableTrace();

sim.repeat(1, () => {
  sim.send(
    new Message(
      unicast("environment"),
      unicast("server"),
      {
        kind: "debug.tick",
        head: { corrId: "", version: "" },
        data: { time: clock.time },
      },
      { requ: true },
    ),
  );
});

sim.repeat(1, () => {
  sim.send(
    new Message<Request>(
      unicast("environment"),
      unicast("server"),
      {
        kind: "promise.create",
        head: { corrId: "", version: "" },
        data: {
          id: genId(n),
          timeoutAt: Number.MAX_SAFE_INTEGER,
          tags: { "resonate:target": "sim://any@default" },
          param: codec.encode({ func: "fibonacci", args: [n], version: 1 }),
        },
      },
      { requ: true },
    ),
  );
});

const settled = sim.execUntil(options.steps, () => {
  const promise = server.server.promises.get(genId(n));
  return promise !== undefined && promise.state !== "pending";
});

if (!settled) {
  console.error(`foo() did not settle after ${options.steps} steps (seed=${seed})`);
  process.exit(1);
}

const promise = server.server.promises.get(genId(n))!;
const decoded = codec.decode({ headers: promise.value.headers || {}, data: promise.value.data || "" });

function f(n: number, memo: Record<number, number> = {}): number {
  if (n <= 1) return n;
  if (memo[n] !== undefined) return memo[n];
  memo[n] = f(n - 1, memo) + f(n - 2, memo);
  return memo[n];
}

const expected = f(n);

if (JSON.stringify(decoded) !== JSON.stringify(expected)) {
  console.error(`foo() expected ${JSON.stringify(expected)} but got ${JSON.stringify(decoded)} with seed=${seed}`);
  process.exit(1);
}

console.log(`foo() settled correctly: ${JSON.stringify(decoded)} (seed=${seed})`);
logTrace();
