
import { Context, Resonate } from "./lib";

import { TFC, LFC, RFC } from "./lib/core/calls";

const resonate = new Resonate({
    url: "http://localhost:8001",
    timeout: 60000,
});

resonate.register("f", async (ctx: Context) => {
    const a = await ctx.run(new LFC(foo, [1, 2, 3]));
    console.log(a);

    const b = await ctx.run(new RFC(foo));
    console.log(b);
});

function foo(ctx: Context, a: number, b: number, c: number) {
    console.log(a, b, c);

    if(a !== 0) {
        return ctx.run(new LFC(foo, [a - 1, b - 1, c - 1]));
    }

    return "foo";
}

resonate.run(new TFC("f", "f.1"));
