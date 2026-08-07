// Probe 2: find the hostname form that works and whether a fresh database is
// connectable immediately (or after propagation delay), using the Hostname the
// platform API returns rather than a guessed one.
//
// Env: TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP. Run from resonate-sdk-ts.

import { mkdirSync, rmSync } from "node:fs";
import { connect } from "@tursodatabase/sync";

const TOKEN = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const GROUP = process.env.TURSO_GROUP ?? "default";
const API = `https://api.turso.tech/v1/organizations/${ORG}`;

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const mint = await api("POST", `/groups/${GROUP}/auth/tokens?expiration=4h&authorization=full-access`);
const groupToken = mint.json?.jwt;

const name = `probe2-${Date.now().toString(36)}`;
const create = await api("POST", "/databases", { name, group: GROUP });
const hostname = create.json?.database?.Hostname;
console.log(`create ${name} -> ${create.status}, hostname=${hostname}`);

const dirBase = "/tmp/turso-probe2";
rmSync(dirBase, { recursive: true, force: true });
mkdirSync(dirBase, { recursive: true });

async function tryConnect(label, url, attempt) {
  const t0 = performance.now();
  try {
    const db = await connect({ path: `${dirBase}/${label}-${attempt}.db`, url, authToken: groupToken });
    console.log(`[${label}] attempt ${attempt}: connect OK in ${Math.round(performance.now() - t0)}ms`);
    return db;
  } catch (err) {
    console.log(
      `[${label}] attempt ${attempt}: FAILED in ${Math.round(performance.now() - t0)}ms: ${String(err?.message ?? err).slice(0, 160)}`,
    );
    return null;
  }
}

// Poll the API-provided hostname for up to ~90s.
const tCreate = performance.now();
let db = null;
for (let i = 0; i < 30 && !db; i++) {
  db = await tryConnect("api-hostname", `libsql://${hostname}`, i);
  if (!db) await new Promise((r) => setTimeout(r, 3000));
}
if (db) {
  console.log(`connectable ${Math.round(performance.now() - tCreate)}ms after create`);
  await db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)");
  await db.exec("INSERT INTO t (v) VALUES ('hello')");
  const t0 = performance.now();
  await db.push();
  console.log(`write+push OK in ${Math.round(performance.now() - t0)}ms`);

  // Independent replica: does it bootstrap from remote on connect, or need pull?
  const db2 = await tryConnect("replica2", `libsql://${hostname}`, 0);
  if (db2) {
    let rows = await (await db2.prepare("SELECT * FROM t").catch(() => null))?.all().catch(() => null);
    console.log(`replica2 rows before pull: ${JSON.stringify(rows)}`);
    const t1 = performance.now();
    await db2.pull();
    rows = await (await db2.prepare("SELECT * FROM t")).all();
    console.log(`replica2 rows after pull (${Math.round(performance.now() - t1)}ms): ${JSON.stringify(rows)}`);
    await db2.close().catch(() => {});
  }
  await db.close().catch(() => {});
}

// Short form for comparison, now that propagation has had time.
const dbShort = await tryConnect("short-form", `libsql://${name}-${ORG}.turso.io`, 0);
if (dbShort) await dbShort.close().catch(() => {});

const del = await api("DELETE", `/databases/${name}`);
console.log(`cleanup -> ${del.status}`);
