import { trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";

const sdk = new NodeSDK({
  traceExporter: new ConsoleSpanExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter(),
  }),
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

sdk.start();
const tracer = trace.getTracer("resonate");
const resonate = Resonate.local({ tracer: tracer });

resonate.register(foo);

async function main(): Promise<void> {
  const v = await resonate.run("foo", foo, "hello world", "21");
  console.log(v);
  resonate.stop();
}

await main();
await sdk.shutdown();
