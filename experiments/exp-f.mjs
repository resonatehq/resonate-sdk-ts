// Experiment F: speculative tenure — does the guard hold across MANY local
// writes, and what does the loser see after re-downloading?
//
// The model under test: acquire, then do all of a tenure's durable steps
// locally with no syncing, then push once at suspend/complete. If the push is
// rejected, delete the replica, re-download, retry.
//
// D3 proved the guard for a single write. A tenure is a batch: ten step rows
// plus one guard bump. Two questions that decide whether the model is safe:
//
//   1. Is the rejection atomic over the WHOLE batch, or can some of a losing
//      tenure's writes land? (If they land, speculative execution corrupts.)
//   2. After the loser re-downloads, what does it see — and is "retry" the
//      right verb, or is the honest answer "discover you lost"?
//
// Run: UV_THREADPOOL_SIZE=64 node experiments/exp-f.mjs [--steps 10] [--n 10]

import { mkdirSync, rmSync } from "node:fs";
import { connect } from "@tursodatabase/sync";
import { Session } from "@tursodatabase/serverless";

const PLATFORM = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const TOKEN = process.env.TURSO_GROUP_TOKEN;
const GROUP = process.env.TURSO_GROUP ?? "default";
const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const STEPS = Number(arg("steps", "10"));
const N = Number(arg("n", "10"));

const DB = `casspec-${Date.now().toString(36)}`;
const URL = `libsql://${DB}-${ORG}.${REGION}.turso.io`;
const base = "/tmp/turso-exp-f";
rmSync(base, { recursive: true, force: true });

async function api(method, path, body) {
  const res = await fetch(`https://api.turso.tech/v1/organizations/${ORG}${path}`, {
    method,
    headers: { authorization: `Bearer ${PLATFORM}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const dirOf = (n) => `${base}/${n}`;
function replica(name) {
  mkdirSync(dirOf(name), { recursive: true });
  return connect({ path: `${dirOf(name)}/db.db`, url: URL, authToken: TOKEN });
}
const rows = async (db, sql, args = []) => await (await db.prepare(sql)).all(...args);
const guardOf = async (db) => Number((await rows(db, "SELECT value FROM cas_table WHERE key='guard'"))[0]?.value);

await api("POST", "/databases", { name: DB, group: GROUP });
const remote = new Session({ url: URL, authToken: TOKEN });
await remote.sequence(`
  CREATE TABLE cas_table (key TEXT PRIMARY KEY, value);
  CREATE TABLE steps (tenure TEXT, who TEXT, n INTEGER);
  CREATE TABLE task (id TEXT PRIMARY KEY, version INTEGER, holder TEXT);`);
await remote.sequence(`
  CREATE TRIGGER cas_table_conflict
  BEFORE UPDATE ON cas_table
  WHEN CAST(NEW.value AS INTEGER) != CAST(OLD.value AS INTEGER) + 1
  BEGIN SELECT RAISE(ROLLBACK, 'unexpected existing row state'); END;`);
await remote.execute("INSERT INTO cas_table VALUES ('guard', 0)");
await remote.execute("INSERT INTO task VALUES ('t', 0, NULL)");
await remote.close().catch(() => {});
console.log(`[setup] ${DB}: guard=0, task version=0, ${STEPS} steps per tenure\n`);

let partials = 0;
let single = 0;
let doubles = 0;
let bothExecuted = 0;
const resetMs = [];

for (let i = 0; i < N; i++) {
  const a = await replica(`a-${i}`);
  const b = await replica(`b-${i}`);
  await a.pull();
  await b.pull();

  // A whole tenure, entirely local: claim the task, run every step, then push
  // once at the end. Both nodes do this — nothing stops either of them,
  // because nothing talks to the remote until the push.
  const tenure = async (db, who) => {
    const v = await guardOf(db);
    await db.exec(`UPDATE task SET version = version + 1, holder = '${who}' WHERE id = 't'`);
    for (let s = 0; s < STEPS; s++) {
      await (await db.prepare("INSERT INTO steps VALUES (?, ?, ?)")).run(`r${i}`, who, s);
    }
    await db.exec(`UPDATE cas_table SET value = ${v + 1} WHERE key='guard'`);
    try {
      await db.push();
      return { who, ok: true };
    } catch (err) {
      return { who, ok: false, err: String(err?.message ?? err) };
    }
  };

  // Both ran the work: that is the point of the experiment, not an accident.
  bothExecuted++;
  const [ra, rb] = await Promise.all([tenure(a, "a"), tenure(b, "b")]);
  const wins = (ra.ok ? 1 : 0) + (rb.ok ? 1 : 0);
  if (wins === 1) single++;
  if (wins === 2) doubles++;

  // Q1: is the rejection atomic across the whole tenure?
  const obs = await replica(`obs-${i}`);
  await obs.pull();
  const landed = await rows(obs, "SELECT who, COUNT(*) AS n FROM steps WHERE tenure = ? GROUP BY who", [`r${i}`]);
  const byWho = Object.fromEntries(landed.map((r) => [r.who, Number(r.n)]));
  const loser = ra.ok ? rb : ra;
  const winner = ra.ok ? ra : rb;
  const loserRows = byWho[loser.who] ?? 0;
  const winnerRows = byWho[winner.who] ?? 0;
  if (wins === 1 && (loserRows !== 0 || winnerRows !== STEPS)) partials++;

  // Q2: what does the loser see after the only recovery there is?
  let sees = "";
  if (wins === 1) {
    const t0 = performance.now();
    await loser.who === "a" ? null : null;
    const db = loser.who === "a" ? a : b;
    await db.close().catch(() => {});
    rmSync(dirOf(`${loser.who}-${i}`), { recursive: true, force: true });
    const fresh = await replica(`${loser.who}-${i}`);
    await fresh.pull();
    resetMs.push(performance.now() - t0);
    const task = (await rows(fresh, "SELECT version, holder FROM task WHERE id='t'"))[0];
    const mySteps = (await rows(fresh, "SELECT COUNT(*) AS n FROM steps WHERE tenure=? AND who=?", [`r${i}`, loser.who]))[0];
    sees = `task v${task.version} held by ${task.holder}; own steps surviving: ${Number(mySteps.n)}`;
    await fresh.close().catch(() => {});
  }

  console.log(
    `iter ${i}: winner=${winner.who} wins=${wins} guard=${await guardOf(obs)} ` +
      `steps landed ${JSON.stringify(byWho)}` +
      (wins === 1 ? `\n         loser ${loser.who} after re-download: ${sees}` : "  <-- BAD"),
  );

  for (const d of [a, b, obs]) await d.close().catch(() => {});
}

const med = (xs) => (xs.length ? xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)].toFixed(0) : "?");
console.log(`\n=== EXPERIMENT F (speculative tenure, ${STEPS} writes each, n=${N}) ===`);
console.log(`both nodes executed the tenure:      ${bothExecuted}/${N}   <- speculation does not prevent this`);
console.log(`exactly one tenure committed:        ${single}/${N}`);
console.log(`double commits:                      ${doubles}`);
console.log(`partial/torn tenures on the remote:  ${partials}   <- must be 0`);
console.log(`re-download after losing (median):   ${med(resetMs)}ms`);
console.log(`[cleanup] ${(await api("DELETE", `/databases/${DB}`)).status}`);
process.exit(0);
