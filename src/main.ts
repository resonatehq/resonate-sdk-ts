import type { Context } from "./context";
import { ResonateInner } from "./resonate-inner";

function* bar(ctx: Context, name: string) {
  return `Hello World ${name}`;
}

function* foo(ctx: Context) {
  const p = yield* ctx.lfi((ctx: Context, x: number) => {
    const a = 24;
    const b = 24;
    return a + b + x;
  }, 100);

  const p2 = yield* ctx.lfi((ctx) => {
    return 39;
  });

  const p3 = yield* ctx.rfi("bar", "Andres").options({ target: "poll://any@gpu/lalal" });

  const v1 = yield* p;
  const v3 = yield* p3;
  const v2 = yield* p2;

  return { v1, v2, v3 };
}

const resonate = ResonateInner.local();

const rfoo = resonate.register("foo", foo);
resonate.register("bar", bar);

rfoo.run(`foo.${Date.now()}`, [], async (iHandler) => {
  const res = await iHandler.result;
  console.log("got", res);
});
