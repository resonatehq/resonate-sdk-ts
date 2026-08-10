// Experiment D2: why didn't the guard trigger fire on push?
//
// Three candidate explanations, tested in order:
//   A. The trigger never reached the remote (pushing DDL through a replica
//      does not register it there).
//   B. The trigger is on the remote and fires for ordinary writes, but the
//      sync path applies changes below the trigger layer (row/frame level),
//      so a push can never trip it.
//   C. It works and the first experiment set it up wrong.
//
// Setup goes through Hrana this time -- a direct server-side connection -- so
// the trigger is unambiguously installed and registered on the remote.
//
// Run: UV_THREADPOOL_SIZE=64 node experiments/exp-d2.mjs

import { mkdirSync, rmSync } from "node:fs";
import { connect } from "@tursodatabase/sync";
import { Session } from "@tursodatabase/serverless";

const PLATFORM = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const TOKEN = process.env.TURSO_GROUP_TOKEN;
const GROUP = process.env.TURSO_GROUP ?? "default";
const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";

const DB = `casdiag-${Date.now().toString(36)}`;
const URL = `libsql://${DB}-${ORG}.${REGION}.turso.io`;
const base = "/tmp/turso-exp-d2";
rmSync(base, { recursive: true, force: true });

async function api(method, path, body) {
  const res = await fetch(`https://api.turso.tech/v1/organizations/${ORG}${path}`, {
    method,
    headers: { authorization: `Bearer ${PLATFORM}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function replica(name) {
  const dir = `${base}/${name}`;
  mkdirSync(dir, { recursive: true });
  return connect({ path: `${dir}/db.db`, url: URL, authToken: TOKEN });
}

console.log(`[provision] ${DB} -> ${(await api("POST", "/databases", { name: DB, group: GROUP })).status}`);

// -- setup on the remote, via Hrana -----------------------------------------

const remote = new Session({ url: URL, authToken: TOKEN });
await remote.sequence(`
  CREATE TABLE cas_table (key TEXT PRIMARY KEY, value);
  CREATE TABLE content (who TEXT, round INTEGER);
`);
await remote.sequence(`
  CREATE TRIGGER cas_table_conflict
  BEFORE UPDATE ON cas_table
  WHEN CAST(NEW.value AS INTEGER) != CAST(OLD.value AS INTEGER) + 1
  BEGIN
    SELECT RAISE(ROLLBACK, 'unexpected existing row state');
  END;
`);
await remote.execute("INSERT INTO cas_table VALUES ('guard', 0)");

const master = await remote.execute("SELECT type, name FROM sqlite_master ORDER BY name");
console.log(`[remote] sqlite_master: ${JSON.stringify(master.rows)}`);

// A: does the trigger fire for an ordinary server-side write?
try {
  await remote.execute("UPDATE cas_table SET value = 99 WHERE key = 'guard'");
  console.log("[remote] BAD-DELTA UPDATE ACCEPTED -> trigger is not firing server-side");
} catch (err) {
  console.log(`[remote] bad-delta update rejected server-side: ${String(err?.message ?? err).slice(0, 120)}`);
}
try {
  await remote.execute("UPDATE cas_table SET value = 1 WHERE key = 'guard'");
  console.log("[remote] good-delta update (0 -> 1) accepted");
} catch (err) {
  console.log(`[remote] good-delta update REJECTED: ${String(err?.message ?? err).slice(0, 120)}`);
}
// Put it back to 0 for the replica tests. (1 -> 0 is a bad delta, so drop and
// reinsert rather than update.)
await remote.execute("DELETE FROM cas_table WHERE key = 'guard'");
await remote.execute("INSERT INTO cas_table VALUES ('guard', 0)");
console.log(`[remote] guard reset to ${JSON.stringify((await remote.execute("SELECT value FROM cas_table")).rows)}`);

// -- does the replica see the trigger, and does it fire locally? -------------

const a = await replica("a");
await a.pull();
const localMaster = await (await a.prepare("SELECT type, name FROM sqlite_master ORDER BY name")).all();
console.log(`[replica] sqlite_master after pull: ${JSON.stringify(localMaster)}`);

try {
  await a.exec("UPDATE cas_table SET value = 77 WHERE key = 'guard'");
  console.log("[replica] bad-delta update accepted LOCALLY -> trigger not firing on the replica either");
} catch (err) {
  console.log(`[replica] bad-delta update rejected locally: ${String(err?.message ?? err).slice(0, 120)}`);
}

// -- the real question: is a stale push rejected? ----------------------------
//
// b takes the version from 0 -> 1 and pushes (should be fine). a, still on
// version 0, then writes 1 as well and pushes: at the remote that is
// OLD=1, NEW=1, which the trigger should reject.

const b = await replica("b");
await b.pull();

await b.exec("UPDATE cas_table SET value = 1 WHERE key = 'guard'");
await (await b.prepare("INSERT INTO content VALUES (?, ?)")).run("b", 0);
await b.push();
console.log("[replica b] pushed 0 -> 1 (uncontended)");

const a2 = await replica("a2");
await a2.pull(); // pulled BEFORE b's push? no -- pull now would see 1. Use a fresh stale one.
// `a` is the genuinely stale replica: it pulled before b pushed.
await a.exec("UPDATE cas_table SET value = 1 WHERE key = 'guard'");
await (await a.prepare("INSERT INTO content VALUES (?, ?)")).run("a", 0);
try {
  await a.push();
  console.log("[replica a] STALE PUSH ACCEPTED -> the trigger does not gate the sync path");
} catch (err) {
  console.log(`[replica a] stale push REJECTED: ${String(err?.message ?? err).slice(0, 240)}`);
}

const obs = await replica("obs");
await obs.pull();
console.log(`[remote final] guard=${JSON.stringify(await (await obs.prepare("SELECT value FROM cas_table")).all())}`);
console.log(`[remote final] content=${JSON.stringify(await (await obs.prepare("SELECT * FROM content")).all())}`);

for (const db of [a, a2, b, obs]) await db.close().catch(() => {});
await remote.close().catch(() => {});
console.log(`[cleanup] ${DB} -> ${(await api("DELETE", `/databases/${DB}`)).status}`);
process.exit(0);
