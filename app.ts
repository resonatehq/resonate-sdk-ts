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
  const v = yield* ctx.run(bar, s, ctx.options({ id: "bar" }));
  return v;
}

function* bar(ctx: Context, s: string): Generator<any, string, any> {
  const v = yield* ctx.run(baz, s, ctx.options({ id: "baz" }));
  return v;
}
function baz(ctx: Context, s: string): string {
  return s;
}

function* fibonacci(ctx: Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const p1 = yield ctx.beginRun(fibonacci, n - 1, ctx.options({ id: `"fib-${n - 1}` }));
  const p2 = yield ctx.beginRun(fibonacci, n - 2, ctx.options({ id: `"fib-${n - 2}` }));

  return (yield p1) + (yield p2);
}

sdk.start();

const resonate = Resonate.local({ tracer: new ResonateTracer({ tracer: trace.getTracer("resonate") }) });

resonate.register(foo);
resonate.register(fibonacci);

async function main(): Promise<void> {
  const v1 = await resonate.run("foo", foo, "hello world", "21");
  const v2 = await resonate.run("fib-10", fibonacci, 10);
  console.log(v1);
  console.log(v2);
  resonate.stop();
}

await main();
await sdk.shutdown();
