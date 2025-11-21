import { type Context, KafkaTransport, Resonate } from "./src/index";

function* fibonacci(ctx: Context, n: number): Generator<any, number, any> {
  if (n <= 1) {
    return n;
  }
  const p1 = yield ctx.beginRpc(fibonacci, n - 1);
  const p2 = yield ctx.beginRpc(fibonacci, n - 2);

  return (yield p1) + (yield p2);
}

async function main() {
  const group = "default";
  const pid = "default-8f32ad1c";

  const addr = "kafka://default";

  const transport = new KafkaTransport({
    group,
    pid,
  });
  await transport.start();

  const resonate = new Resonate({ group, pid, addr, network: transport, messageSource: transport });

  resonate.register("fib", fibonacci);

  const v = await resonate.rpc("fib.1", fibonacci, 7);
  console.log(v);
}

main();
