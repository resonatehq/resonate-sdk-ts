import type * as context from "./context";
import { ResonateInner } from "./resonate-inner";

function* fib(ctx: context.Context, n: number): Generator {
  if (n <= 1) {
    return n;
  }
  return (yield ctx.lfc(fib, n - 1)) + (yield ctx.lfc(fib, n - 2));
}

const resonate = ResonateInner.local();

const rib = resonate.register("foo", fib);

rib.run("fib", [10], async (iHandler) => {
  const res = await iHandler.result;
  console.log("got", res);
});
