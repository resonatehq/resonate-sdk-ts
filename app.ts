import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ZipkinExporter } from "@opentelemetry/exporter-zipkin";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";
import { OpenTelemetryTracer } from "./src/tracer";

const sdk = new NodeSDK({
  traceExporter: new ZipkinExporter({ serviceName: "resonate" }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

const resonate = Resonate.remote({ tracer: new OpenTelemetryTracer("resonate") });

function* foo(ctx: Context) {
  console.log(`[foo] '${ctx.id}'`);
  yield* ctx.rpc(bar);
}

function* bar(ctx: Context) {
  console.log(`[bar] '${ctx.id}'`);
  yield* ctx.rpc(baz);
}

function baz(ctx: Context) {
  console.log(`[baz] '${ctx.id}'`);

  // Randomly fail 50% of the time
  if (Math.random() < 0.9) {
    throw new Error(`[baz] Failed for '${ctx.id}'`);
  }

  console.log(`[baz] Succeeded for '${ctx.id}'`);
}

resonate.register(foo);
resonate.register(bar);
resonate.register(baz);

async function main(): Promise<void> {
  // const v1 = await resonate.rpc("foo", foo, "hello world", "21");
  // resonate.run("f1", foo);
  const v = await resonate.rpc("f1", foo);
  // const v3 = await resonate.run("countdown.1", countdown, 5, 1, "http");
  console.log(v);
  // console.log(v2);
  // console.log(v3);
  resonate.stop();
}

await main();
await sdk.shutdown();
