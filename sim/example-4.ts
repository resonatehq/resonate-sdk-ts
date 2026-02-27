import { StepClock } from "../src/clock.js";
import { Codec } from "../src/codec.js";
import type { Context } from "../src/context.js";
import type { Request } from "../src/network/types.js";
import { Registry } from "../src/registry.js";
import { ServerProcess } from "./src/server.js";
import { Message, Random, Simulator, unicast } from "./src/simulator.js";
import { WorkerProcess } from "./src/worker.js";

// foo -> bar -> baz call chain (no network disruptions)

function* foo(ctx: Context): Generator<any, any, any> {
  const p = yield ctx.beginRpc("bar");
  return yield p;
}

function* bar(ctx: Context): Generator<any, any, any> {
  const p = yield ctx.beginRpc("baz");
  return yield p;
}

function baz(_: Context) {
  return "baz";
}

const seed = Math.floor(Math.random() * 2 ** 32);

const options = { seed, steps: 100_000, randomDelay: 0, dropProb: 0, duplProb: 0, charFlipProb: 0 };

const rnd = new Random(options.seed);
const clock = new StepClock();
const codec = new Codec();
const registry = new Registry();
registry.add(foo);
registry.add(bar);
registry.add(baz);

const sim = new Simulator(rnd, {
  randomDelay: options.randomDelay,
  dropProb: options.dropProb,
  duplProb: options.duplProb,
});

const server = new ServerProcess(clock, "server");
const worker1 = new WorkerProcess(rnd, clock, registry, { charFlipProb: options.charFlipProb }, "worker-1", "default");

sim.register(server);
for (const worker of [worker1]) {
  sim.register(worker);
  worker.core.tracer.enable();
}

const id = "foo";

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
          id,
          timeoutAt: Number.MAX_SAFE_INTEGER,
          tags: { "resonate:target": "sim://any@default" },
          param: codec.encode({ func: "foo", args: [], version: 1 }),
        },
      },
      { requ: true },
    ),
  );
});

const settled = sim.execUntil(options.steps, () => {
  const promise = server.server.promises.get(id);
  return promise !== undefined && promise.state !== "pending";
});

if (!settled) {
  console.error(`foo() did not settle after ${options.steps} steps (seed=${seed})`);
  process.exit(1);
}

const promise = server.server.promises.get(id)!;
const decoded = codec.decode({ headers: promise.value.headers || {}, data: promise.value.data || "" });

// foo returns [bar_result, bar_result], bar returns [baz_result, baz_result], baz returns "baz"
const expected = "baz";

if (JSON.stringify(decoded) !== JSON.stringify(expected)) {
  console.error(`foo() expected ${JSON.stringify(expected)} but got ${JSON.stringify(decoded)} with seed=${seed}`);
  process.exit(1);
}

console.log(`foo() settled correctly: ${JSON.stringify(decoded)} (seed=${seed})`);
for (const worker of [worker1]) {
  const n = worker.core.tracer.executions.length;
  if (n > 0) {
    console.log(`\n[${worker.iaddr}]`);
    worker.core.tracer.log();
  }
}
