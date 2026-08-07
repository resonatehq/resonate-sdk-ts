// Experiment A: does the fleet converge through the remote?
//
// Three phases:
//   1. Raw propagation lag — write+push on replica A, how long until pull on
//      replica B sees it. This is the physics bound under the timer index.
//   2. Fleet convergence — a workflow parked on a durable sleep by node 0
//      (which then stops) must be resumed and completed by node 1, whose only
//      way of learning about it is the tenant timeout index through the remote.
//   3. Index integrity at quiescence — compare the tenant index against the
//      union of origin databases: stale rows are cheap by design, missing rows
//      are the dangerous direction (the `published` stale-skip suspicion).
//
// Env: TURSO_GROUP_TOKEN (rw), TURSO_ORG. Databases must be pre-created (see
// provision.sh): expa-lag, expa-timeouts, expa-<wf-id>.
//
// Run from resonate-sdk-ts:
//   npx tsx experiments/exp-a.ts --wf wf0 --sleep 4000 --trials 10

import { mkdirSync, rmSync } from "node:fs";
import { Codec, ConsoleLogger, type Context, NoopEncryptor, Resonate } from "../src/index.js";
import { libsqlDriver, TursoNetwork, tursoSyncDriver } from "../src/network/turso/index.js";

// --dry validates the script against a shared local `file:` database: no
// credentials, no remote, phase 1 skipped (nothing to propagate through).
const DRY = process.argv.includes("--dry");

const TOKEN = process.env.TURSO_GROUP_TOKEN;
const ORG = process.env.TURSO_ORG;
if (!DRY && (!TOKEN || !ORG)) {
  console.error("need TURSO_GROUP_TOKEN and TURSO_ORG (or --dry)");
  process.exit(1);
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const WF = arg("wf", "wf0"); // origin; remote db expa-<WF> must exist
const SLEEP = Number(arg("sleep", "4000"));
const TRIALS = Number(arg("trials", "10"));
const TICK = 100;

const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";
const url = (name: string) => `libsql://${name}-${ORG}.${REGION}.turso.io`;
const base = "/tmp/turso-exp-a";
rmSync(base, { recursive: true, force: true });
if (DRY) mkdirSync(`${base}/shared`, { recursive: true });

function driverFor(node: string) {
  const dir = `${base}/${node}`;
  mkdirSync(dir, { recursive: true });
  if (DRY) return libsqlDriver({ url: `file:${base}/shared/` });
  return tursoSyncDriver({ dir, url, authToken: TOKEN });
}

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (who: string, msg: string) => console.log(`${stamp()} [${who}] ${msg}`);

// ---------------------------------------------------------------------------
// Phase 1: raw write->push->pull->read propagation lag
// ---------------------------------------------------------------------------

async function phase1(): Promise<void> {
  console.log(`\n=== PHASE 1: raw propagation lag, ${TRIALS} trials ===`);
  const a = await driverFor("lag-a").open("expa-lag");
  const b = await driverFor("lag-b").open("expa-lag");
  await a.execute("CREATE TABLE IF NOT EXISTS lag (i INTEGER PRIMARY KEY, t INTEGER)");
  await a.push?.();
  await b.pull?.();

  const lags: number[] = [];
  for (let i = 0; i < TRIALS; i++) {
    const t0 = performance.now();
    await a.transaction(async (tx) => {
      await tx.execute("INSERT OR REPLACE INTO lag (i, t) VALUES (?, ?)", [i, Date.now()]);
    });
    await a.push?.();
    const pushed = performance.now();
    // Poll b as fast as pull allows.
    for (;;) {
      await b.pull?.();
      const rows = await b.execute("SELECT i FROM lag WHERE i = ?", [i]);
      if (rows.length > 0) break;
    }
    const seen = performance.now();
    lags.push(seen - t0);
    log("lag", `trial ${i}: write->visible ${(seen - t0).toFixed(0)}ms (push took ${(pushed - t0).toFixed(0)}ms)`);
  }
  lags.sort((x, y) => x - y);
  const pick = (q: number) => lags[Math.min(lags.length - 1, Math.floor(q * lags.length))].toFixed(0);
  console.log(
    `phase1 result: n=${lags.length} min=${pick(0)}ms median=${pick(0.5)}ms p90=${pick(0.9)}ms max=${lags[lags.length - 1].toFixed(0)}ms`,
  );
  await a.close();
  await b.close();
}

// ---------------------------------------------------------------------------
// Phase 2: park on node 0, resume on node 1
// ---------------------------------------------------------------------------

function makeNode(name: string) {
  const network = new TursoNetwork({
    driver: driverFor(name),
    prefix: "expa-",
    timeoutDatabase: "timeouts",
    pid: name,
    tickMs: TICK,
    retryTimeout: 5_000,
    logger: new ConsoleLogger("warn"),
  });
  const resonate = new Resonate({ pid: name, network });
  resonate.register("wait", function* (ctx: Context, ms: number): any {
    log(name, `wait(${ms}) parking`);
    yield* ctx.sleep(ms);
    log(name, `wait(${ms}) resumed HERE`);
    return { wokeOn: name, ms };
  });
  return { network, resonate };
}

async function phase2(): Promise<void> {
  console.log(`\n=== PHASE 2: park on node0, stop it, node1 must resume (sleep=${SLEEP}ms) ===`);
  const id = WF; // origin == id; remote db expa-<id> must exist
  const codec = new Codec(new NoopEncryptor());

  const n0 = makeNode("node0");
  const n1 = makeNode("node1");

  const tStart = Date.now();
  await n0.resonate.beginRun(id, "wait", SLEEP);
  log("node0", `beginRun(${id}) accepted at +${Date.now() - tStart}ms`);

  // Give node 0 long enough to durably park the sleep and flush the timer,
  // then take it away entirely: only node 1 can resume now. `stop()` marks the
  // network stopped and kills the tick timer before it closes connections, so
  // even a hung close leaves the node inert — race it rather than wait, and
  // report the hang (sync-engine close blocks when a pull is in flight).
  await new Promise((r) => setTimeout(r, Math.min(1500, SLEEP / 2)));
  const stopOutcome = await Promise.race([
    n0.resonate.stop().then(() => "clean"),
    new Promise<string>((r) => setTimeout(() => r("HUNG (proceeding; node is inert)"), 5000)),
  ]);
  log("node0", `stopped (${stopOutcome}) at +${Date.now() - tStart}ms`);

  const deadline = Date.now() + SLEEP + 120_000;
  let result: unknown;
  let resolvedAt = 0;
  while (Date.now() < deadline) {
    const p: any = await n1.resonate.promises.get(id).catch(() => undefined);
    if (p && p.state !== "pending") {
      resolvedAt = Date.now();
      result = codec.decode(p.value);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (resolvedAt === 0) {
    console.log(`phase2 result: NOT COMPLETED within ${SLEEP + 120_000}ms — cross-node pickup FAILED`);
  } else {
    const total = resolvedAt - tStart;
    console.log(
      `phase2 result: completed in ${total}ms total; sleep=${SLEEP}ms -> resume overhead ${total - SLEEP}ms; result=${JSON.stringify(result)}`,
    );
  }
  // Same close() hang risk as node 0 — see turso.md's operational gotchas.
  const n1Stop = await Promise.race([
    n1.resonate.stop().then(() => "clean"),
    new Promise<string>((r) => setTimeout(() => r("HUNG (proceeding)"), 5000)),
  ]);
  log("node1", `stopped (${n1Stop})`);
}

// ---------------------------------------------------------------------------
// Phase 3: tenant index vs. origin truth at quiescence
// ---------------------------------------------------------------------------

async function phase3(): Promise<void> {
  console.log("\n=== PHASE 3: index integrity at quiescence ===");
  const d = driverFor("observer");
  const tenant = await d.open("expa-timeouts");
  await tenant.pull?.();
  const index = await tenant.execute("SELECT origin, id, kind, timeout_at FROM timeouts ORDER BY origin, id");
  console.log(`tenant index rows: ${JSON.stringify(index)}`);

  const origin = await d.open(`expa-${WF}`);
  await origin.pull?.();
  const pt = await origin.execute("SELECT id, timeout_at FROM promise_timeouts");
  const tt = await origin.execute("SELECT id, kind, timeout_at FROM task_timeouts");
  console.log(`origin expa-${WF} armed: promise_timeouts=${JSON.stringify(pt)} task_timeouts=${JSON.stringify(tt)}`);

  const armed = pt.length + tt.length;
  const indexed = index.filter((r) => r.origin === WF).length;
  if (armed === 0 && indexed === 0) console.log("phase3 result: CONSISTENT (both empty)");
  else if (armed > indexed)
    console.log(`phase3 result: MISSING ENTRIES — ${armed} armed vs ${indexed} indexed (dangerous)`);
  else if (indexed > armed)
    console.log(`phase3 result: STALE ENTRIES — ${indexed} indexed vs ${armed} armed (benign by design)`);
  else console.log("phase3 result: CONSISTENT");
  await tenant.close();
  await origin.close();
}

const PHASES = arg("phase", "1,2,3").split(",");
if (PHASES.includes("1")) {
  if (!DRY) await phase1();
  else console.log("=== PHASE 1 skipped in --dry (no remote to propagate through) ===");
}
if (PHASES.includes("2")) await phase2();
if (PHASES.includes("3")) await phase3();
process.exit(0);
