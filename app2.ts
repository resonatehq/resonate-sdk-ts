import type { Context } from "./src/context";
import { Resonate } from "./src/resonate";
import * as util from "./src/util";

const prefix = "myPrefix";
const resonate = new Resonate({ prefix });

function qux(ctx: Context) {
  util.assert(ctx.id.startsWith(prefix), `expected id to start with "${prefix}", got "${ctx.id}"`);
  util.assert(
    !ctx.id.startsWith(`${prefix}:${prefix}`),
    `expected id to not start with "${prefix}:${prefix}", got "${ctx.id}"`,
  );
  return "qux";
}

function* baz(ctx: Context) {
  util.assert(ctx.id.startsWith(prefix), `expected id to start with "${prefix}", got "${ctx.id}"`);
  util.assert(
    !ctx.id.startsWith(`${prefix}:${prefix}`),
    `expected id to not start with "${prefix}:${prefix}", got "${ctx.id}"`,
  );
  yield* ctx.run(qux);
  return "baz";
}

function* bar(ctx: Context) {
  util.assert(ctx.id.startsWith(prefix), `expected id to start with "${prefix}", got "${ctx.id}"`);
  util.assert(
    !ctx.id.startsWith(`${prefix}:${prefix}`),
    `expected id to not start with "${prefix}:${prefix}", got "${ctx.id}"`,
  );
  return "bar";
}

function* foo(ctx: Context) {
  const p = yield* ctx.beginRun(bar);
  yield* ctx.run(baz, ctx.options({ id: "bazId" }));
  yield* ctx.run(qux);
  yield* p;
  return "ok";
}
const f = resonate.register("foo", foo);
await f.run("fooId");

resonate.stop();
