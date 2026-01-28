import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";

const resonate = Resonate.local();

function* foo(ctx: Context) {
  return "foo";
}

resonate.register(foo);

async function main() {
  const v = await resonate.run("foo.1", foo);
  console.log(v);
}

main();
