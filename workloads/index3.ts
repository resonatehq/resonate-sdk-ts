// W3 — one function, both invocation kinds, chosen by parity. Copied from
// `resonate-specification/work/ts/index3.ts`, adapted to run over
// `S3Network`. Set S3_TRACE=<prefix> to record for the checkers.
//
//   foo(n, m):  n == 0  ->  1
//               n even  ->  sum of m LOCAL  calls to foo(n-1, m)
//               n odd   ->  sum of m REMOTE calls to foo(n-1, m)
//
// W1 and W2 each use one invocation kind throughout. W3 alternates them
// *within a single call tree*, so local and remote children interleave in
// one id space. Fan-out is `m` on both sides, so the tree is a uniform
// m-ary tree of depth n and only the EDGE KIND alternates:
//
//   value(n, m) = m^n                       (each level multiplies by m)
//   size(n, m)  = 1 + m + ... + m^n         (a full m-ary tree of depth n)
//
// Counting promises and counting tasks against those closed forms is the
// cheapest conformance check in the spec's workload folder — a task exists
// iff the promise carries a target — so this run asserts both, straight
// from the origin's own document via promise.search / task.search.
//
// Usage:
//   npx tsx workloads/index3.ts <id> [n] [m] [--via run|rpc]

import { type Context, Resonate } from "../src/async/index.js";
import { counts, flag, positionals, rig } from "./harness.js";

async function foo(ctx: Context, n: number, m: number): Promise<number> {
  report(ctx, n, m);

  if (n === 0) return 1;

  let r = 0;
  if (n % 2 === 0) {
    for (let i = 0; i < m; i++) {
      r = r + (await ctx.run<number>("foo", n - 1, m));
    }
  } else {
    for (let i = 0; i < m; i++) {
      r = r + (await ctx.rpc<number>("foo", n - 1, m));
    }
  }
  return r;
}

/** The same recursion without durability, to check the answer: m^n. */
function value(n: number, m: number): number {
  if (n === 0) return 1;
  return m * value(n - 1, m);
}

/** Invocations in the tree: a full m-ary tree of depth n. */
function size(n: number, m: number): number {
  if (n === 0) return 1;
  return 1 + m * size(n - 1, m);
}

/**
 * Invocations reached by a REMOTE edge, which is exactly the number of tasks:
 * the root (which has a task however it was started) plus every level whose
 * parent was odd. Levels alternate, so it is every other level counting up
 * from the leaves.
 */
function remote(n: number, m: number): number {
  let total = 1; // the root
  for (let d = 1; d <= n; d++) {
    // level d was created by a parent at n-d+1; that parent used rpc iff odd
    if ((n - d + 1) % 2 === 1) total += m ** d;
  }
  return total;
}

function report(ctx: Context, n: number, m: number): void {
  const kind = n === 0 ? "leaf" : n % 2 === 0 ? "even/run" : "odd/rpc";
  console.log(
    [
      `foo(${n},${m})`.padEnd(11),
      kind.padEnd(9),
      `id=${ctx.id}`.padEnd(30),
      `parent=${ctx.parentId}`.padEnd(30),
      `branch=${ctx.branchId}`.padEnd(30),
      `origin=${ctx.originId}`.padEnd(22),
      `prefix=${ctx.prefixId}`,
    ].join(" "),
  );
}

const positional = positionals();
const id = positional[0];
if (!id) {
  console.error("usage: tsx workloads/index3.ts <id> [n] [m] [--via run|rpc]");
  process.exit(1);
}
const n = Number(positional[1] ?? 4);
const m = Number(positional[2] ?? 2);
const via = flag("via", "run");

const r = rig();
const resonate = new Resonate({ network: r.network });
resonate.register("foo", foo);

console.log(
  `W3  mixed  id=${id}  n=${n}  m=${m}  via=resonate.${via}` +
    `   expect value=${value(n, m)} over ${size(n, m)} invocations` +
    ` (${remote(n, m)} remote)\n`,
);

const handle = via === "rpc" ? await resonate.rpc(id, "foo", n, m) : await resonate.run(id, "foo", n, m);

const result = await handle.result();
console.log(`\nresult          = ${result}`);
console.log(`expected        = ${value(n, m)}`);

const fetched = await resonate.get(id);
console.log(`resonate.get    = ${await fetched.result()}`);

const counted = await counts(r.raw, id);
console.log(`promises        = ${counted.promises} (expected ${size(n, m)})`);
console.log(`tasks           = ${counted.tasks} (expected ${remote(n, m)})`);

await resonate.stop();
await r.done();

let failed = false;
if (result !== value(n, m)) {
  console.error(`MISMATCH: got ${result}, expected ${value(n, m)}`);
  failed = true;
}
if (counted.promises !== size(n, m)) {
  console.error(`PROMISE COUNT MISMATCH: got ${counted.promises}, expected ${size(n, m)}`);
  failed = true;
}
if (counted.tasks !== remote(n, m)) {
  console.error(`TASK COUNT MISMATCH: got ${counted.tasks}, expected ${remote(n, m)}`);
  failed = true;
}
if (failed) process.exit(1);
