// Probe: does Turso Cloud auto-create a database on first sync connect?
//
// Answers the handoff's load-bearing question empirically, plus gathers the
// operational facts around it: creation latency via the platform API, whether
// a fresh database is connectable immediately, and whether data round-trips
// through the cloud between two replicas.
//
// Env:
//   TURSO_PLATFORM_TOKEN  platform API token (turso auth api-tokens mint)
//   TURSO_ORG             org slug
//   TURSO_GROUP           group name (default "default")
//
// Run from resonate-sdk-ts:  node experiments/probe.mjs

import { mkdirSync, rmSync } from "node:fs";
import { connect } from "@tursodatabase/sync";

const TOKEN = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const GROUP = process.env.TURSO_GROUP ?? "default";
if (!TOKEN || !ORG) {
  console.error("need TURSO_PLATFORM_TOKEN and TURSO_ORG");
  process.exit(1);
}

const API = `https://api.turso.tech/v1/organizations/${ORG}`;

async function api(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Math.round(performance.now() - t0);
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, ms, json };
}

const dirBase = "/tmp/turso-probe";
rmSync(dirBase, { recursive: true, force: true });
mkdirSync(dirBase, { recursive: true });

function hostFor(name) {
  return `libsql://${name}-${ORG}.turso.io`;
}

async function trySync(label, name, dir, groupToken) {
  mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  try {
    const db = await connect({
      path: `${dir}/${name}.db`,
      url: hostFor(name),
      authToken: groupToken,
    });
    const connectMs = Math.round(performance.now() - t0);
    console.log(`[${label}] connect OK in ${connectMs}ms`);
    return db;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.log(`[${label}] connect FAILED in ${ms}ms: ${String(err?.message ?? err)}`);
    return null;
  }
}

// -- 0. sanity: who are we, what exists --------------------------------------

const orgInfo = await api("GET", "");
console.log(`[org] GET org -> ${orgInfo.status}`, JSON.stringify(orgInfo.json?.organization ?? orgInfo.json).slice(0, 300));

const groups = await api("GET", "/groups");
console.log(`[org] groups -> ${groups.status}:`, (groups.json?.groups ?? []).map((g) => `${g.name}(${g.version ?? "?"})`).join(", "));

const dbs = await api("GET", "/databases");
console.log(`[org] databases -> ${dbs.status}: count=${dbs.json?.databases?.length ?? "?"}`);

// -- 1. mint a fresh short-lived rw group token ------------------------------

const mint = await api("POST", `/groups/${GROUP}/auth/tokens?expiration=4h&authorization=full-access`);
console.log(`[token] mint group token -> ${mint.status} in ${mint.ms}ms`);
const groupToken = mint.json?.jwt;
if (!groupToken) {
  console.error("[token] no jwt in response:", JSON.stringify(mint.json).slice(0, 300));
  process.exit(1);
}

// -- 2. the question: connect to a database that does not exist --------------

const missing = `probe-missing-${Date.now().toString(36)}`;
console.log(`\n=== AUTO-CREATE PROBE: sync connect to nonexistent db "${missing}" ===`);
const dbMissing = await trySync("missing", missing, `${dirBase}/missing`, groupToken);
if (dbMissing) {
  // If this "succeeded", find out whether it actually created anything remote,
  // or whether failure is deferred to first pull/push.
  try {
    const t0 = performance.now();
    const changed = await dbMissing.pull();
    console.log(`[missing] pull -> ${changed} in ${Math.round(performance.now() - t0)}ms`);
  } catch (err) {
    console.log(`[missing] pull FAILED: ${String(err?.message ?? err)}`);
  }
  try {
    await dbMissing.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER)");
    await dbMissing.exec("INSERT INTO t VALUES (1)");
    const t0 = performance.now();
    await dbMissing.push();
    console.log(`[missing] push OK in ${Math.round(performance.now() - t0)}ms — REMOTE AUTO-CREATED?`);
  } catch (err) {
    console.log(`[missing] push FAILED: ${String(err?.message ?? err)}`);
  }
  // Did that materialize a database platform-side?
  const check = await api("GET", `/databases/${missing}`);
  console.log(`[missing] platform GET /databases/${missing} -> ${check.status}`);
  await dbMissing.close().catch(() => {});
}

// -- 3. create via platform API, measure, then connect -----------------------

const created = `probe-created-${Date.now().toString(36)}`;
console.log(`\n=== PLATFORM CREATE: "${created}" in group "${GROUP}" ===`);
const create = await api("POST", "/databases", { name: created, group: GROUP });
console.log(`[create] POST /databases -> ${create.status} in ${create.ms}ms`, JSON.stringify(create.json).slice(0, 200));

const dbA = await trySync("created/replicaA", created, `${dirBase}/a`, groupToken);
if (dbA) {
  await dbA.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY, v TEXT)");
  await dbA.exec("INSERT INTO t (v) VALUES ('hello-from-a')");
  const t0 = performance.now();
  await dbA.push();
  console.log(`[created/replicaA] write+push in ${Math.round(performance.now() - t0)}ms`);

  // Round-trip: a second, independent replica should see the row.
  const dbB = await trySync("created/replicaB", created, `${dirBase}/b`, groupToken);
  if (dbB) {
    const t1 = performance.now();
    await dbB.pull();
    const rows = await (await dbB.prepare("SELECT * FROM t")).all();
    console.log(
      `[created/replicaB] pull+read in ${Math.round(performance.now() - t1)}ms -> ${JSON.stringify(rows)}`,
    );
    await dbB.close().catch(() => {});
  }
  await dbA.close().catch(() => {});
}

// -- 4. creation latency over a few samples (cost of one-db-per-workflow) ----

console.log("\n=== CREATE LATENCY SAMPLES ===");
const names = [];
for (let i = 0; i < 5; i++) {
  const name = `probe-lat-${Date.now().toString(36)}-${i}`;
  const r = await api("POST", "/databases", { name, group: GROUP });
  console.log(`[latency] create #${i} -> ${r.status} in ${r.ms}ms`);
  if (r.status < 300) names.push(name);
}

// -- 5. cleanup probes -------------------------------------------------------

console.log("\n=== CLEANUP ===");
for (const name of [missing, created, ...names]) {
  const r = await api("DELETE", `/databases/${name}`);
  console.log(`[cleanup] delete ${name} -> ${r.status}`);
}

console.log("\nGroup token (rw, 4h) for the experiments:");
console.log(groupToken);
