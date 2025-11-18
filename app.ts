import { type Context, KafkaMessageSource, KafkaNetwork, Resonate } from "./src/index";

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

  const network = new KafkaNetwork({ group, pid });
  await network.start();

  const messageSource = new KafkaMessageSource({ group, pid });
  await messageSource.start();

  const resonate = new Resonate({ group, pid, addr, network, messageSource });

  resonate.register("fib", fibonacci);

  const v = await resonate.rpc("fib.1", fibonacci, 10);
  console.log(v);
}

main();
