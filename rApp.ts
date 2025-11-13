import { type Context, KafkaNetwork, Resonate } from "./src/index";

function foo(ctx: Context): string {
  return "foo";
}

async function main() {
  const network = new KafkaNetwork({ verbose: true });
  await network.start();

  const resonate = new Resonate({ network });

  resonate.register(foo);

  const v = await resonate.run("foo.1", foo);
  console.log(v);
}

main();
