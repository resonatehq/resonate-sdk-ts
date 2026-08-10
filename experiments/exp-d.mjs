// Experiment D: does a guard table + BEFORE UPDATE trigger make `push()` a
// compare-and-swap?
//
// The idea (from the Turso team): a row whose trigger rejects any update that
// is not exactly +1. Two replicas both read version v, both write v+1 locally,
// both do their work, both push. The remote applies pushes one at a time, so
// the second one sees OLD.value = v+1 and NEW.value = v+1 -- not OLD+1 -- and
// RAISE(ROLLBACK) rejects it. If the rejection is ATOMIC over the whole push,
// that is exactly the fence the embedded-replica CAS was missing.
//
// Four questions, in order of how much they matter:
//   1. Does exactly one of two racing pushes win?
//   2. Is the loser's *work* rejected too, or only its guard row?  (If the
//      work lands, the guard is decoration.)
//   3. What state is the loser's replica left in, and can it recover?
//   4. What does it cost?
//
// Env: TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP_TOKEN, TURSO_GROUP.
// Run:  UV_THREADPOOL_SIZE=64 node experiments/exp-d.mjs [--n 20]

import { mkdirSync, rmSync } from "node:fs";
import { connect } from "@tursodatabase/sync";

const PLATFORM = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const TOKEN = process.env.TURSO_GROUP_TOKEN;
const GROUP = process.env.TURSO_GROUP ?? "default";
const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";
if (!PLATFORM || !ORG || !TOKEN) throw new Error("need TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP_TOKEN");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const N = Number(arg("n", "20"));

const DB = `casguard-${Date.now().toString(36)}`;
const URL = `libsql://${DB}-${ORG}.${REGION}.turso.io`;
const base = "/tmp/turso-exp-d";
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

const rows = async (db, sql, args = []) => await (await db.prepare(sql)).all(...args);
const val = async (db) => Number((await rows(db, "SELECT value FROM cas_table WHERE key = 'guard'"))[0]?.value);

console.log(`[provision] ${DB} -> ${(await api("POST", "/databases", { name: DB, group: GROUP })).status}`);

// -- schema, including the guard trigger, installed through one replica ------

const setup = await replica("setup");
await setup.exec("CREATE TABLE cas_table (key TEXT PRIMARY KEY, value)");
await setup.exec(`
  CREATE TRIGGER cas_table_conflict
  BEFORE UPDATE ON cas_table
  WHEN CAST(NEW.value AS INTEGER) != CAST(OLD.value AS INTEGER) + 1
  BEGIN
    SELECT RAISE(ROLLBACK, 'unexpected existing row state');
  END`);
await setup.exec("CREATE TABLE content (who TEXT, round INTEGER)");
await setup.exec("INSERT INTO cas_table VALUES ('guard', 0)");
await setup.push();
console.log("[setup] schema + trigger + guard row pushed to remote");
await setup.close();

// -- the race ----------------------------------------------------------------

const counts = { single: 0, double: 0, none: 0 };
const winnerMs = [];
let recoveryOk = 0;
let recoveryTried = 0;
let atomicityViolations = 0;

for (let i = 0; i < N; i++) {
  const a = await replica(`a-${i}`);
  const b = await replica(`b-${i}`);
  await a.pull();
  await b.pull();

  const seen = { a: await val(a), b: await val(b) };
  if (seen.a !== seen.b) console.log(`  (replicas started from different versions: ${seen.a} vs ${seen.b})`);

  // Both stake the same next version, then do their own work.
  const attempt = async (db, who) => {
    const v = await val(db);
    await db.exec(`UPDATE cas_table SET value = ${v + 1} WHERE key = 'guard'`);
    await (await db.prepare("INSERT INTO content VALUES (?, ?)")).run(who, i);
    const t0 = performance.now();
    try {
      await db.push();
      return { who, ok: true, ms: performance.now() - t0 };
    } catch (err) {
      return { who, ok: false, ms: performance.now() - t0, err: String(err?.message ?? err) };
    }
  };

  const [ra, rb] = await Promise.all([attempt(a, "a"), attempt(b, "b")]);
  const wins = (ra.ok ? 1 : 0) + (rb.ok ? 1 : 0);
  counts[wins === 2 ? "double" : wins === 1 ? "single" : "none"]++;
  for (const r of [ra, rb]) if (r.ok) winnerMs.push(r.ms);

  // Q2: did the loser's WORK land on the remote anyway?
  const observer = await replica(`obs-${i}`);
  await observer.pull();
  const landed = (await rows(observer, "SELECT who FROM content WHERE round = ?", [i])).map((r) => r.who);
  const remoteV = await val(observer);
  const loser = ra.ok ? rb : ra;
  const violated = wins === 1 && landed.includes(loser.who);
  if (violated) atomicityViolations++;

  console.log(
    `iter ${i}: a=${ra.ok ? `WON ${ra.ms.toFixed(0)}ms` : "lost"} b=${rb.ok ? `WON ${rb.ms.toFixed(0)}ms` : "lost"}` +
      ` -> ${wins} winner(s); remote guard=${remoteV}, content=[${landed}]` +
      (violated ? "  <-- LOSER'S WORK LANDED ANYWAY" : "") +
      (wins !== 1 ? "  <-- BAD" : ""),
  );
  if (wins === 1 && i === 0) console.log(`  loser error: ${loser.err?.slice(0, 220)}`);

  // Q3: can the loser recover — pull, re-read, retry?
  if (wins === 1) {
    recoveryTried++;
    const db = ra.ok ? b : a;
    try {
      await db.pull();
      const v = await val(db);
      await db.exec(`UPDATE cas_table SET value = ${v + 1} WHERE key = 'guard'`);
      await (await db.prepare("INSERT INTO content VALUES (?, ?)")).run(`${loser.who}-retry`, i);
      await db.push();
      recoveryOk++;
    } catch (err) {
      console.log(`  recovery FAILED: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  await observer.close().catch(() => {});
  await a.close().catch(() => {});
  await b.close().catch(() => {});
}

winnerMs.sort((x, y) => x - y);
console.log(`\n=== EXPERIMENT D RESULT (n=${N}) ===`);
console.log(`single winner: ${counts.single}`);
console.log(`double wins:   ${counts.double}`);
console.log(`no winner:     ${counts.none}`);
console.log(`loser's work landed anyway (atomicity violations): ${atomicityViolations}`);
console.log(`loser recovered by pull+retry: ${recoveryOk}/${recoveryTried}`);
console.log(`winning push latency median: ${winnerMs[Math.floor(winnerMs.length / 2)]?.toFixed(0) ?? "?"}ms`);

console.log(`\n[cleanup] ${DB} -> ${(await api("DELETE", `/databases/${DB}`)).status}`);
process.exit(0);
