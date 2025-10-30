import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ZipkinExporter } from "@opentelemetry/exporter-zipkin";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";
import { ResonateTracer } from "./src/tracer";

const sdk = new NodeSDK({
  traceExporter: new ZipkinExporter({ serviceName: "resonate" }),
  instrumentations: [getNodeAutoInstrumentations()],
});

function* foo(ctx: Context, s: string): Generator<any, string, any> {
  let v: string = "";
  for (let i = 1; i <= 10; i++) {
    v = yield ctx.run(bar, s, ctx.options({ id: `bar.${i}` }));
  }

  return v;
}

function* bar(ctx: Context, s: string): Generator<any, string, any> {
  const v = yield ctx.run(baz, s, ctx.options({ id: "baz" }));
  return v;
}
function* baz(ctx: Context, s: string): Generator<any, string, any> {
  return s;
}

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

const resonate = Resonate.remote({ tracer: new ResonateTracer({ tracer: trace.getTracer("resonate") }) });

resonate.register(foo);
resonate.register(bar);
resonate.register(baz);
resonate.register(fibonacci);
resonate.register(countdown);

async function main(): Promise<void> {
  const v1 = await resonate.run("foo.1", "foo", "hello world", "21");
  // const v2 = await resonate.run("fib-10", fibonacci, 10);
  // const v3 = await resonate.run("countdown.1", countdown, 5, 1, "http");
  console.log(v1);
  // console.log(v2);
  // console.log(v3);
  resonate.stop();
}

await main();
await sdk.shutdown();
