import type * as context from "./src/context";
import { ResonateInner } from "./src/resonate-inner";

function* fib(ctx: context.Context, n: number): Generator {
  if (n <= 1) {
    return n;
  }
  return (yield ctx.rfc("fib", n - 1)) + (yield ctx.rfc("fib", n - 2));
}

const resonate = ResonateInner.local("default", "worker");

const rib = resonate.register("fib", fib);

rib.run("fib", [10], async (iHandler) => {
  const res = await iHandler.result;
  console.log("got", res);
});
