// W2 — sequential REMOTE invocation. Copied from
// `resonate-specification/work/ts/index2.ts`, adapted to run over
// `S3Network`. Set S3_TRACE=<prefix> to record for the checkers.
//
//   foo calls bar n times with ctx.rpc, awaiting each before the next.
//
// One word different from W1, and the difference is dispatch: the child
// carries a `resonate:target`, so a task is created and an `execute` is
// dispatched. `foo` cannot continue while it waits, so it suspends and is
// resumed when the child settles — promises, tasks, dispatch, suspend and
// resume, all through the two buckets.
//
// Usage:
//   npx tsx workloads/index2.ts <id> [n] [--via run|rpc]

import { type Context, Resonate } from "../src/async/index.js";
import { flag, positionals, rig } from "./harness.js";

async function foo(ctx: Context, n: number): Promise<number> {
  report(ctx, "foo", n);
  for (let i = 0; i < n; i++) {
    await ctx.rpc("bar", i);
  }
  return n;
}

async function bar(ctx: Context, i: number): Promise<number> {
  report(ctx, "bar", i);
  return i;
}

/**
 * The four ids every invocation carries. See index1.ts — the shapes are the
 * same, which is the point: `run` and `rpc` differ in dispatch, not in
 * identity.
 */
function report(ctx: Context, fn: string, arg: number): void {
  console.log(
    [
      `${fn}(${arg})`.padEnd(8),
      `id=${ctx.id}`.padEnd(34),
      `prefix=${ctx.prefixId}`.padEnd(28),
      `origin=${ctx.originId}`.padEnd(28),
      `parent=${ctx.parentId}`.padEnd(34),
      `branch=${ctx.branchId}`,
    ].join(" "),
  );
}

const positional = positionals();
const id = positional[0];
if (!id) {
  console.error("usage: tsx workloads/index2.ts <id> [n] [--via run|rpc]");
  process.exit(1);
}
const n = Number(positional[1] ?? 3);
const via = flag("via", "run");

const r = rig();
const resonate = new Resonate({ network: r.network });
resonate.register("foo", foo);
resonate.register("bar", bar);

console.log(`W2  ctx.rpc   id=${id}  n=${n}  via=resonate.${via}\n`);

const handle = via === "rpc" ? await resonate.rpc(id, "foo", n) : await resonate.run(id, "foo", n);

const result = await handle.result();
console.log(`\nresult          = ${result}`);

const fetched = await resonate.get(id);
console.log(`resonate.get    = ${await fetched.result()}`);

await resonate.stop();
await r.done();

if (result !== n) {
  console.error(`MISMATCH: got ${result}, expected ${n}`);
  process.exit(1);
}
