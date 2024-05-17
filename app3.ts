import { Resonate, Context } from './lib/async';

const resonate = new Resonate({
    timeout: Number.MAX_SAFE_INTEGER,
});

const foo = resonate.register("foo", async (ctx: Context) => {
    // await new Promise((resolve) => setTimeout(resolve, 10000));
    // return "foo";
    return await ctx.run(() => "foo", ctx.options({ durable: true }));
}, { durable: false });

async function main() {
    // const f = resonate.run("foo", "foo.0");
    const f = foo("foo.0");

    const p = await f.created;
    console.log(p);

    console.log("1");

    const r = await f;
    console.log("HAR 1!", r);

    const f2 = foo("foo.0");
    console.log(f);
    console.log(f2);

    const p2 = await f2.created;
    console.log(p2);

    console.log("a");
    const r2 = await f2;
    console.log("b");
    console.log("HAR 2!", r2);
}

main();

