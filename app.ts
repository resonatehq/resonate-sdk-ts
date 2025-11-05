import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ZipkinExporter } from "@opentelemetry/exporter-zipkin";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";
import { OtelTracer } from "./src/tracer";

const sdk = new NodeSDK({
  traceExporter: new ZipkinExporter({ serviceName: "resonate" }),
  instrumentations: [getNodeAutoInstrumentations()],
});

function* fibonacci(ctx: Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const p1 = yield ctx.beginRpc("fibonacci", n - 1, ctx.options({ id: `fib-${n - 1}` }));
  const p2 = yield ctx.beginRpc("fibonacci", n - 2, ctx.options({ id: `fib-${n - 2}` }));

  return (yield p1) + (yield p2);
}

async function notify(_ctx: Context, url: string, msg: string) {
  console.log(msg);
}

export function* countdown(ctx: Context, count: number, delay: number, url: string) {
  for (let i = count; i > 0; i--) {
    // send notification to ntfy.sh
    yield* ctx.run(notify, url, `Countdown: ${i}`);
    // sleep
    yield* ctx.sleep(delay * 60 * 1000);
  }
  // send the last notification to ntfy.sh
  yield* ctx.run(notify, url, `Done`);
}

sdk.start();

const resonate = Resonate.remote({ tracer: new OtelTracer("resonate") });

function* foo(ctx: Context, s: string): Generator<any, string, any> {
  const value = yield ctx.rpc(bar, s, ctx.options({ id: "bar" }));
  return value;
}

function* bar(ctx: Context, s: string): Generator<any, string, any> {
  const v = yield ctx.rpc("baz", s, ctx.options({ id: "baz" }));
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function baz(ctx: Context, s: string): Promise<string> {
  await sleep(2_000);

  // Randomly throw an error 50% of the time
  if (Math.random() < 0.3) {
    throw new Error("Random failure in baz");
  }

  return s;
}

resonate.register(foo);
resonate.register(bar);
resonate.register(baz);
resonate.register(fibonacci);
resonate.register(countdown);

async function main(): Promise<void> {
  // const v1 = await resonate.rpc("foo", foo, "hello world", "21");
  const v2 = await resonate.rpc("fib-10", fibonacci, 10);
  // const v3 = await resonate.run("countdown.1", countdown, 5, 1, "http");
  console.log(v2);
  // console.log(v2);
  // console.log(v3);
  resonate.stop();
}

await main();
await sdk.shutdown();
