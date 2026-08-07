// Experiment B: does `remoteWrites` make CAS sound across nodes?
//
// Two TursoNetwork instances, separate replica dirs, same remote, no sharding.
// Per iteration: node 0 creates a targeted promise (so a version-0 task
// exists), node 1 opens a fresh view of the same remote, then both race
// `task.acquire` for the same {id, version: 0}. Count who got 2xx.
//
//   remoteWrites=false  -> expect occasional double-wins (both 2xx)
//   remoteWrites=true   -> expect exactly one 2xx, every time
//
// Env: TURSO_GROUP_TOKEN (rw), TURSO_ORG. Pre-created remote databases:
//   expb0-race, expb0-timeouts   (local-writes mode)
//   expb1-race, expb1-timeouts   (remote-writes mode)
//
// Run from resonate-sdk-ts:
//   npx tsx experiments/exp-b.ts --mode local  --n 50
//   npx tsx experiments/exp-b.ts --mode remote --n 50

import { mkdirSync, rmSync } from "node:fs";
import { ConsoleLogger } from "../src/index.js";
import { libsqlDriver, type TursoDriver, TursoNetwork, tursoSyncDriver } from "../src/network/turso/index.js";
import type { Request } from "../src/network/types.js";
import { VERSION } from "../src/util.js";

// --dry runs the whole script against a shared local `file:` database instead
// of Turso Cloud: no credentials, no propagation, single serialization point —
// only useful for validating the script itself (expect single wins always).
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

const MODE = arg("mode", "local"); // local | remote
const N = Number(arg("n", "50"));
const remoteWrites = MODE === "remote";
const PREFIX = remoteWrites ? "expb1-" : "expb0-";
const ORIGIN = "race";
const TARGET = "poll://any@default";

const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";
const url = (name: string) => `libsql://${name}-${ORG}.${REGION}.turso.io`;
const base = `/tmp/turso-exp-b-${MODE}`;
rmSync(base, { recursive: true, force: true });
if (DRY) mkdirSync(`${base}/shared`, { recursive: true });

function syncDriver(dir: string): TursoDriver {
  mkdirSync(dir, { recursive: true });
  if (DRY) return libsqlDriver({ url: `file:${base}/shared/` });
  return tursoSyncDriver({ dir, url, authToken: TOKEN, remoteWrites });
}

/** A driver that pulls on open, so a fresh instance starts from the latest remote state. */
function freshDriver(dir: string): TursoDriver {
  const inner = syncDriver(dir);
  return {
    async open(name) {
      const conn = await inner.open(name);
      await conn.pull?.();
      return conn;
    },
  };
}

let corr = 0;
const head = () => ({ corrId: `c${++corr}`, version: VERSION }) as Request["head"];

function makeNet(driver: TursoDriver, pid: string): TursoNetwork {
  return new TursoNetwork({
    driver,
    prefix: PREFIX,
    timeoutDatabase: "timeouts",
    pid,
    // Keep the sweeper out of the way: this measures the CAS, not recovery.
    tickMs: 3_600_000,
    retryTimeout: 3_600_000,
    logger: new ConsoleLogger("warn"),
  });
}

type AcquireOutcome = { status: number | string; version?: number; ms: number };

async function acquire(net: TursoNetwork, id: string, pid: string): Promise<AcquireOutcome> {
  const t0 = performance.now();
  try {
    const res: any = await net.send({
      kind: "task.acquire",
      head: head(),
      data: { id, version: 0, pid, ttl: 60_000 },
    });
    return { status: res.head.status, version: res.data?.task?.version, ms: performance.now() - t0 };
  } catch (err) {
    return { status: `ERR:${String((err as Error)?.message ?? err).slice(0, 120)}`, ms: performance.now() - t0 };
  }
}

const run = Date.now().toString(36); // unique promise ids per run, same origin db
const net0 = makeNet(syncDriver(`${base}/n0`), "n0");
await net0.init();

const counts = { double: 0, single: 0, none: 0 };
const details: string[] = [];

for (let i = 0; i < N; i++) {
  const id = `${ORIGIN}.${run}.t${i}`;
  const created: any = await net0.send({
    kind: "promise.create",
    head: head(),
    data: { id, timeoutAt: Date.now() + 3_600_000, param: {}, tags: { "resonate:target": TARGET } },
  });
  if (created.head.status >= 300) {
    console.log(`iter ${i}: promise.create -> ${created.head.status}, skipping`);
    continue;
  }

  // Node 1 gets a fresh view of the remote each iteration — a brand-new
  // network whose driver pulls on open — so its replica provably contains the
  // task before the race starts.
  const net1 = makeNet(freshDriver(`${base}/n1-${i}`), "n1");
  await net1.init();
  const probe: any = await net1.send({ kind: "promise.get", head: head(), data: { id } });
  if (probe.head.status !== 200) {
    console.log(`iter ${i}: node1 cannot see the promise (${probe.head.status}) — remote not caught up, skipping race`);
    await net1.stop();
    continue;
  }

  const [a0, a1] = await Promise.all([acquire(net0, id, "n0"), acquire(net1, id, "n1")]);
  const ok = (o: AcquireOutcome) => typeof o.status === "number" && o.status >= 200 && o.status < 300;
  const wins = (ok(a0) ? 1 : 0) + (ok(a1) ? 1 : 0);
  if (wins === 2) counts.double++;
  else if (wins === 1) counts.single++;
  else counts.none++;
  const line = `iter ${i}: n0=${a0.status}(${a0.ms.toFixed(0)}ms) n1=${a1.status}(${a1.ms.toFixed(0)}ms) -> ${wins} winner(s)${wins === 2 ? "  <-- DOUBLE WIN" : ""}`;
  details.push(line);
  console.log(line);

  await net1.stop();
}

await net0.stop();

console.log(`\n=== EXPERIMENT B RESULT (mode=${MODE}, remoteWrites=${remoteWrites}, n=${N}) ===`);
console.log(`double wins: ${counts.double}`);
console.log(`single wins: ${counts.single}`);
console.log(`no winner:   ${counts.none}`);
process.exit(0);
