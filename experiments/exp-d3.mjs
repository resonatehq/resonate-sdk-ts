// Experiment D3: the guard trigger, decisively.
//
// D2 showed a *sequential* stale push is rejected atomically when the trigger
// is installed server-side. Three things still decide whether the SDK can use
// this:
//
//   1. Does DDL pushed FROM A REPLICA install a working guard? This matters
//      more than it sounds: `TursoStore.migrate` runs its DDL through the
//      driver, which for the sync driver is a replica. If replica-pushed
//      triggers do not gate the sync path, the guard has to be installed at
//      provisioning time instead, which changes the deployment story.
//   2. Under a genuine CONCURRENT race (both push at once), is there exactly
//      one winner?
//   3. Can the loser recover — pull, replay, push — and what does it cost?
//
// Run: UV_THREADPOOL_SIZE=64 node experiments/exp-d3.mjs [--n 20]

import { mkdirSync, rmSync } from "node:fs";
import { connect } from "@tursodatabase/sync";
import { Session } from "@tursodatabase/serverless";

const PLATFORM = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const TOKEN = process.env.TURSO_GROUP_TOKEN;
const GROUP = process.env.TURSO_GROUP ?? "default";
const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const N = Number(arg("n", "20"));

const base = "/tmp/turso-exp-d3";
rmSync(base, { recursive: true, force: true });

async function api(method, path, body) {
  const res = await fetch(`https://api.turso.tech/v1/organizations/${ORG}${path}`, {
    method,
    headers: { authorization: `Bearer ${PLATFORM}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const TRIGGER = `
  CREATE TRIGGER cas_table_conflict
  BEFORE UPDATE ON cas_table
  WHEN CAST(NEW.value AS INTEGER) != CAST(OLD.value AS INTEGER) + 1
  BEGIN
    SELECT RAISE(ROLLBACK, 'unexpected existing row state');
  END`;

function replica(db, name) {
  const dir = `${base}/${db}/${name}`;
  mkdirSync(dir, { recursive: true });
  return connect({
    path: `${dir}/db.db`,
    url: `libsql://${db}-${ORG}.${REGION}.turso.io`,
    authToken: TOKEN,
  });
}
const val = async (db) => Number((await (await db.prepare("SELECT value FROM cas_table WHERE key='guard'")).all())[0]?.value);

// ---------------------------------------------------------------------------
// Q1: does a replica-installed trigger gate the sync path?
// ---------------------------------------------------------------------------

async function installedFromReplica() {
  const DB = `casrep-${Date.now().toString(36)}`;
  await api("POST", "/databases", { name: DB, group: GROUP });
  const setup = await replica(DB, "setup");
  await setup.exec("CREATE TABLE cas_table (key TEXT PRIMARY KEY, value)");
  await setup.exec(TRIGGER);
  await setup.exec("CREATE TABLE content (who TEXT)");
  await setup.exec("INSERT INTO cas_table VALUES ('guard', 0)");
  await setup.push();
  await setup.close();

  // Is the trigger actually on the remote?
  const remote = new Session({ url: `libsql://${DB}-${ORG}.${REGION}.turso.io`, authToken: TOKEN });
  const master = await remote.execute("SELECT type, name FROM sqlite_master WHERE type='trigger'");
  console.log(`[replica-installed] remote triggers: ${JSON.stringify(master.rows)}`);

  const a = await replica(DB, "a");
  const b = await replica(DB, "b");
  await a.pull();
  await b.pull();
  await b.exec("UPDATE cas_table SET value = 1 WHERE key='guard'");
  await b.push();
  await a.exec("UPDATE cas_table SET value = 1 WHERE key='guard'"); // stale
  await (await a.prepare("INSERT INTO content VALUES (?)")).run("a");
  let gated;
  try {
    await a.push();
    gated = false;
  } catch {
    gated = true;
  }
  console.log(`[replica-installed] stale push ${gated ? "REJECTED (guard works)" : "ACCEPTED (guard does NOT work)"}`);
  for (const d of [a, b]) await d.close().catch(() => {});
  await remote.close().catch(() => {});
  await api("DELETE", `/databases/${DB}`);
  return gated;
}

// ---------------------------------------------------------------------------
// Q2/Q3: concurrent race with a server-installed guard
// ---------------------------------------------------------------------------

async function concurrentRace() {
  const DB = `casrace-${Date.now().toString(36)}`;
  await api("POST", "/databases", { name: DB, group: GROUP });
  const url = `libsql://${DB}-${ORG}.${REGION}.turso.io`;
  const remote = new Session({ url, authToken: TOKEN });
  await remote.sequence("CREATE TABLE cas_table (key TEXT PRIMARY KEY, value); CREATE TABLE content (who TEXT, round INTEGER);");
  await remote.sequence(`${TRIGGER};`);
  await remote.execute("INSERT INTO cas_table VALUES ('guard', 0)");
  await remote.close().catch(() => {});

  const counts = { single: 0, double: 0, none: 0 };
  const winMs = [];
  const recoverMs = [];
  let violations = 0;
  let recovered = 0;
  let attempted = 0;

  for (let i = 0; i < N; i++) {
    const a = await replica(DB, `a-${i}`);
    const b = await replica(DB, `b-${i}`);
    await a.pull();
    await b.pull();

    const attempt = async (db, who) => {
      const v = await val(db);
      await db.exec(`UPDATE cas_table SET value = ${v + 1} WHERE key='guard'`);
      await (await db.prepare("INSERT INTO content VALUES (?, ?)")).run(who, i);
      const t0 = performance.now();
      try {
        await db.push();
        return { who, db, ok: true, ms: performance.now() - t0 };
      } catch (err) {
        return { who, db, ok: false, ms: performance.now() - t0, err: String(err?.message ?? err) };
      }
    };

    const [ra, rb] = await Promise.all([attempt(a, "a"), attempt(b, "b")]);
    const wins = (ra.ok ? 1 : 0) + (rb.ok ? 1 : 0);
    counts[wins === 2 ? "double" : wins === 1 ? "single" : "none"]++;
    for (const r of [ra, rb]) if (r.ok) winMs.push(r.ms);

    const obs = await replica(DB, `obs-${i}`);
    await obs.pull();
    const landed = (await (await obs.prepare("SELECT who FROM content WHERE round = ?")).all(i)).map((r) => r.who);
    const guard = await val(obs);
    const loser = ra.ok ? rb : ra;
    const violated = wins === 1 && landed.includes(loser.who);
    if (violated) violations++;

    let note = "";
    // Q3: recovery — pull, replay the work, push again.
    if (wins === 1) {
      attempted++;
      const t0 = performance.now();
      try {
        await loser.db.pull();
        const v = await val(loser.db);
        await loser.db.exec(`UPDATE cas_table SET value = ${v + 1} WHERE key='guard'`);
        await (await loser.db.prepare("INSERT INTO content VALUES (?, ?)")).run(`${loser.who}2`, i);
        await loser.db.push();
        recovered++;
        recoverMs.push(performance.now() - t0);
      } catch (err) {
        note = `  recovery FAILED: ${String(err?.message ?? err).slice(0, 140)}`;
      }
    }

    console.log(
      `iter ${i}: ${wins} winner(s) guard=${guard} content=[${landed}]` +
        (violated ? "  <-- LOSER'S WORK LANDED" : "") +
        (wins !== 1 ? "  <-- BAD" : "") +
        note,
    );
    if (i === 0 && wins === 1) console.log(`  loser error: ${loser.err?.slice(0, 200)}`);

    for (const d of [a, b, obs]) await d.close().catch(() => {});
  }

  const med = (xs) => (xs.length ? xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)].toFixed(0) : "?");
  console.log(`\n=== CONCURRENT RACE (n=${N}) ===`);
  console.log(`single winner: ${counts.single}`);
  console.log(`double wins:   ${counts.double}`);
  console.log(`no winner:     ${counts.none}`);
  console.log(`loser's work landed anyway: ${violations}`);
  console.log(`loser recovered by pull+replay+push: ${recovered}/${attempted} (median ${med(recoverMs)}ms)`);
  console.log(`winning push latency median: ${med(winMs)}ms`);
  await api("DELETE", `/databases/${DB}`);
}

console.log("=== Q1: is a replica-installed trigger enough? ===");
await installedFromReplica();
console.log("\n=== Q2/Q3: concurrent race, server-installed trigger ===");
await concurrentRace();
process.exit(0);
