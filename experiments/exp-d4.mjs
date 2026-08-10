// Experiment D4: how does a node recover after losing a guarded push?
//
// D3 established the guard works: 20/20 single winner, atomic. The blocker is
// the loser. Its local replica still holds the rejected change, and `pull()`
// then fails with "failed to replay local change after remote apply" -- so the
// obvious recovery (pull, replay, push again) does not work.
//
// The sync client exposes no revert/rollback API (pull, push, checkpoint,
// stats, exec, prepare, transaction, close). So this measures the candidates:
//
//   A. retry pull() a few times   -- is the failure transient?
//   B. checkpoint() then pull()   -- does WAL checkpointing clear it?
//   C. close, delete the local files, reconnect -- full re-bootstrap, and what
//      does it cost? This is the fallback the SDK would have to use.
//
// Run: UV_THREADPOOL_SIZE=64 node experiments/exp-d4.mjs

import { mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { connect } from "@tursodatabase/sync";
import { Session } from "@tursodatabase/serverless";

const PLATFORM = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const TOKEN = process.env.TURSO_GROUP_TOKEN;
const GROUP = process.env.TURSO_GROUP ?? "default";
const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";

const DB = `casrec-${Date.now().toString(36)}`;
const URL = `libsql://${DB}-${ORG}.${REGION}.turso.io`;
const base = "/tmp/turso-exp-d4";
rmSync(base, { recursive: true, force: true });

async function api(method, path, body) {
  const res = await fetch(`https://api.turso.tech/v1/organizations/${ORG}${path}`, {
    method,
    headers: { authorization: `Bearer ${PLATFORM}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const dirOf = (name) => `${base}/${name}`;
function replica(name) {
  mkdirSync(dirOf(name), { recursive: true });
  return connect({ path: `${dirOf(name)}/db.db`, url: URL, authToken: TOKEN });
}
const val = async (db) => Number((await (await db.prepare("SELECT value FROM cas_table WHERE key='guard'")).all())[0]?.value);
const short = (e) => String(e?.message ?? e).slice(0, 110);

await api("POST", "/databases", { name: DB, group: GROUP });
const remote = new Session({ url: URL, authToken: TOKEN });
await remote.sequence("CREATE TABLE cas_table (key TEXT PRIMARY KEY, value); CREATE TABLE content (who TEXT);");
await remote.sequence(`
  CREATE TRIGGER cas_table_conflict
  BEFORE UPDATE ON cas_table
  WHEN CAST(NEW.value AS INTEGER) != CAST(OLD.value AS INTEGER) + 1
  BEGIN SELECT RAISE(ROLLBACK, 'unexpected existing row state'); END;`);
await remote.execute("INSERT INTO cas_table VALUES ('guard', 0)");
await remote.close().catch(() => {});
console.log(`[setup] ${DB} ready, guard=0\n`);

/** Drive one loser: stake a stale version, do work, push, expect rejection. */
async function makeLoser(name, bumpRemoteFirst) {
  const db = await replica(name);
  await db.pull();
  const v = await val(db);
  if (bumpRemoteFirst) {
    const other = await replica(`${name}-winner`);
    await other.pull();
    await other.exec(`UPDATE cas_table SET value = ${(await val(other)) + 1} WHERE key='guard'`);
    await other.push();
    await other.close().catch(() => {});
  }
  await db.exec(`UPDATE cas_table SET value = ${v + 1} WHERE key='guard'`);
  await (await db.prepare("INSERT INTO content VALUES (?)")).run(name);
  try {
    await db.push();
    return { db, rejected: false };
  } catch (err) {
    console.log(`[${name}] push rejected: ${short(err)}`);
    return { db, rejected: true };
  }
}

// -- A: is the pull failure transient? --------------------------------------

console.log("=== A: retry pull() ===");
{
  const { db } = await makeLoser("a", true);
  for (let i = 0; i < 3; i++) {
    try {
      const changed = await db.pull();
      console.log(`[a] pull attempt ${i}: OK (changed=${changed})`);
      break;
    } catch (err) {
      console.log(`[a] pull attempt ${i}: ${short(err)}`);
    }
  }
  // Can it push after the pulls?
  try {
    await db.push();
    console.log("[a] push after pulls: OK");
  } catch (err) {
    console.log(`[a] push after pulls: ${short(err)}`);
  }
  await db.close().catch(() => {});
}

// -- B: checkpoint() then pull() --------------------------------------------

console.log("\n=== B: checkpoint() then pull() ===");
{
  const { db } = await makeLoser("b", true);
  try {
    await db.checkpoint();
    console.log("[b] checkpoint: OK");
  } catch (err) {
    console.log(`[b] checkpoint: ${short(err)}`);
  }
  try {
    await db.pull();
    console.log("[b] pull after checkpoint: OK");
  } catch (err) {
    console.log(`[b] pull after checkpoint: ${short(err)}`);
  }
  await db.close().catch(() => {});
}

// -- C: re-bootstrap from scratch -------------------------------------------

console.log("\n=== C: close, delete local files, reconnect ===");
{
  const { db } = await makeLoser("c", true);
  const files = readdirSync(dirOf("c"));
  const bytes = files.reduce((n, f) => n + statSync(`${dirOf("c")}/${f}`).size, 0);
  console.log(`[c] local replica before reset: ${files.length} files, ${(bytes / 1024).toFixed(0)}KB`);

  const t0 = performance.now();
  await db.close().catch(() => {});
  rmSync(dirOf("c"), { recursive: true, force: true });
  const fresh = await replica("c");
  await fresh.pull();
  const ms = performance.now() - t0;
  console.log(`[c] re-bootstrap: ${ms.toFixed(0)}ms, guard now ${await val(fresh)}`);

  // And can it now do a clean guarded write?
  try {
    const v = await val(fresh);
    await fresh.exec(`UPDATE cas_table SET value = ${v + 1} WHERE key='guard'`);
    await (await fresh.prepare("INSERT INTO content VALUES (?)")).run("c-retry");
    await fresh.push();
    console.log("[c] retry after re-bootstrap: OK -- recovery path works");
  } catch (err) {
    console.log(`[c] retry after re-bootstrap: ${short(err)}`);
  }
  await fresh.close().catch(() => {});
}

// -- what the remote ended up with ------------------------------------------

const obs = await replica("obs");
await obs.pull();
console.log(`\n[remote] guard=${await val(obs)}`);
console.log(`[remote] content=${JSON.stringify((await (await obs.prepare("SELECT who FROM content")).all()).map((r) => r.who))}`);
await obs.close().catch(() => {});
console.log(`[cleanup] ${DB} -> ${(await api("DELETE", `/databases/${DB}`)).status}`);
process.exit(0);
