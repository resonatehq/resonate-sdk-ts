import { Resonate, Context } from './lib/async';

const resonate = new Resonate({
    timeout: Number.MAX_SAFE_INTEGER,
});

const foo = resonate.register("foo", async (ctx: Context) => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    return "foo";
});

async function main() {
    // const f = resonate.run("foo", "foo.0");
    const f = foo("foo.0");

    const p = await f.created;
    console.log(p);

    const r = await f;
    console.log(r);
}

main();

