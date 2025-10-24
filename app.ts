import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";

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

const resonate = Resonate.local();

resonate.register(foo);

async function main(): Promise<void> {
  const v = await resonate.run("foo", foo, "hello world");
  console.log(v);
  resonate.stop();
}

main();
