// Experiment E: does the guard trigger fix the PROTOCOL's fence?
//
// D3 proved the primitive in isolation. This runs the real thing: two
// TursoNetwork instances, separate replicas, one remote, NO sharding, both
// issuing `task.acquire` for the same {id, version: 0}. Experiment B measured
// that arrangement at 50/50 double wins. If the guard works, it is 0.
//
// The wiring is a driver decorator rather than a change to src/, so this
// proves the design without committing to it:
//
//   * every WRITING transaction bumps the guard row inside its own
//     BEGIN IMMEDIATE, so the guard advances exactly once per write;
//   * the push happens immediately after that transaction commits, and IS the
//     commit point — a rejected push means another node got there first;
//   * read-only transactions (the store's timer read) skip both, so flushes
//     do not burn versions.
//
// Env: TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP_TOKEN, TURSO_GROUP.
// Run:  UV_THREADPOOL_SIZE=64 npx tsx experiments/exp-e.ts --n 20

import { mkdirSync, rmSync } from "node:fs";
import { ConsoleLogger } from "../src/index.js";
import { type TursoConnection, type TursoDriver, TursoNetwork, tursoSyncDriver } from "../src/network/turso/index.js";
import type { Request } from "../src/network/types.js";
import { VERSION } from "../src/util.js";

const PLATFORM = process.env.TURSO_PLATFORM_TOKEN;
const ORG = process.env.TURSO_ORG;
const TOKEN = process.env.TURSO_GROUP_TOKEN;
const GROUP = process.env.TURSO_GROUP ?? "default";
const REGION = process.env.TURSO_REGION ?? "aws-us-west-2";
if (!PLATFORM || !ORG || !TOKEN) throw new Error("need TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP_TOKEN");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const N = Number(arg("n", "20"));

const PREFIX = "expe-";
const ORIGIN = "race";
const RUN = Date.now().toString(36);
const TARGET = "poll://any@default";
const base = "/tmp/turso-exp-e";
rmSync(base, { recursive: true, force: true });

const url = (name: string) => `libsql://${name}-${ORG}.${REGION}.turso.io`;

async function api(method: string, path: string, body?: unknown) {
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
  BEGIN SELECT RAISE(ROLLBACK, 'unexpected existing row state'); END`;

/**
 * Provision a database with the guard installed SERVER-SIDE.
 *
 * It has to be server-side: DDL pushed from a replica does not register a
 * trigger on the remote (measured — `sqlite_master` on the remote comes back
 * with no triggers at all), so the guard would silently do nothing.
 */
async function provisionGuarded(name: string): Promise<void> {
  await api("POST", "/databases", { name, group: GROUP });
  const { Session } = await import("@tursodatabase/serverless");
  const remote = new Session({ url: url(name), authToken: TOKEN });
  await remote.sequence("CREATE TABLE IF NOT EXISTS cas_table (key TEXT PRIMARY KEY, value)");
  try {
    await remote.sequence(`${TRIGGER};`);
  } catch {
    /* already installed */
  }
  await remote.execute("INSERT INTO cas_table VALUES ('guard', 0) ON CONFLICT DO NOTHING");
  await remote.close().catch(() => {});
}

/** True for statements that change rows — the ones that need arbitrating. */
const WRITES = /^\s*(insert|update|delete|replace)\b/i;

/**
 * Wrap a driver so that every writing transaction is arbitrated by the remote:
 * bump the guard inside the transaction, then push. A rejected push is a lost
 * race — it throws, and the caller sees the failure instead of a phantom win.
 */
function guarded(inner: TursoDriver, dir: string): TursoDriver {
  return {
    replicates: true,
    async open(name: string): Promise<TursoConnection> {
      let conn = await inner.open(name);
      // Only origin databases carry a guard; the tenant index passes through.
      const has = await conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cas_table'");
      if (has.length === 0) return conn;

      /**
       * Throw away this replica and bootstrap a fresh one from the remote.
       *
       * Required, not optional: a replica whose push was rejected still holds
       * the rejected change, and every later `pull` fails with "failed to
       * replay local change after remote apply" — retrying does not clear it
       * and neither does `checkpoint()`. The client exposes no revert, so the
       * only way back is to delete the local files and re-bootstrap. Measured
       * at ~420ms for a small database.
       */
      const resetLocal = async (): Promise<void> => {
        await conn.close().catch(() => {});
        for (const suffix of ["", "-changes", "-info", "-wal", "-wal-revert", "-shm"]) {
          rmSync(`${dir}/${name}.db${suffix}`, { force: true });
        }
        conn = await inner.open(name);
      };

      return {
        execute: (sql, args) => conn.execute(sql, args),
        pull: () => conn.pull!(),
        push: () => conn.push!(),
        close: () => conn.close(),
        async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
          let wrote = false;
          const result = await conn.transaction(async (tx) => {
            const value = await fn({
              execute: (sql: string, args?: unknown[]) => {
                if (WRITES.test(sql)) wrote = true;
                return tx.execute(sql, args);
              },
            });
            if (wrote) {
              const rows = await tx.execute("SELECT value FROM cas_table WHERE key='guard'");
              const v = Number(rows[0]?.value ?? 0);
              await tx.execute("UPDATE cas_table SET value = ? WHERE key='guard'", [v + 1]);
            }
            return value;
          });
          // The push is the real commit: it either lands or the trigger
          // rejects it because someone else advanced the guard first. A
          // rejection must leave this node usable, so the replica is reset
          // before the loss is reported.
          if (wrote) {
            try {
              await conn.push?.();
            } catch (err) {
              await resetLocal();
              throw err;
            }
          }
          return result;
        },
      };
    },
  };
}

function makeNet(dir: string, pid: string): TursoNetwork {
  mkdirSync(dir, { recursive: true });
  return new TursoNetwork({
    driver: guarded(tursoSyncDriver({ dir, url, authToken: TOKEN }), dir),
    prefix: PREFIX,
    timeoutDatabase: "timeouts",
    pid,
    tickMs: 3_600_000,
    retryTimeout: 3_600_000,
    pushOn: "request",
    logger: new ConsoleLogger("error"),
  });
}

let corr = 0;
const head = () => ({ corrId: `e${++corr}`, version: VERSION }) as Request["head"];

await provisionGuarded(`${PREFIX}${ORIGIN}`);
await api("POST", "/databases", { name: `${PREFIX}timeouts`, group: GROUP });
console.log(`[provision] ${PREFIX}${ORIGIN} guarded, ${PREFIX}timeouts plain\n`);

const net0 = makeNet(`${base}/n0`, "n0");
await net0.init();

const counts = { single: 0, double: 0, none: 0 };
const winMs: number[] = [];

for (let i = 0; i < N; i++) {
  const id = `${ORIGIN}.${RUN}.t${i}`;
  let created: any;
  try {
    created = await net0.send({
      kind: "promise.create",
      head: head(),
      data: { id, timeoutAt: Date.now() + 3_600_000, param: {}, tags: { "resonate:target": TARGET } },
    });
  } catch (err) {
    // The creator lost the previous round; its replica has just been reset,
    // so the write is simply replayed against fresh state.
    console.log(`iter ${i}: create retried after a reset (${String((err as Error).message).slice(0, 60)}...)`);
    created = await net0.send({
      kind: "promise.create",
      head: head(),
      data: { id, timeoutAt: Date.now() + 3_600_000, param: {}, tags: { "resonate:target": TARGET } },
    });
  }
  if (created.head.status >= 300) {
    console.log(`iter ${i}: create -> ${created.head.status}, skipping`);
    continue;
  }

  // A second node with a fresh replica that has provably caught up.
  const net1 = makeNet(`${base}/n1-${i}`, "n1");
  await net1.init();
  const seen: any = await net1.send({ kind: "promise.get", head: head(), data: { id } });
  if (seen.head.status !== 200) {
    console.log(`iter ${i}: node1 cannot see the promise yet (${seen.head.status}), skipping`);
    await net1.stop();
    continue;
  }

  const acquire = async (net: TursoNetwork, pid: string) => {
    const t0 = performance.now();
    try {
      const res: any = await net.send({
        kind: "task.acquire",
        head: head(),
        data: { id, version: 0, pid, ttl: 60_000 },
      });
      const ok = res.head.status >= 200 && res.head.status < 300;
      return { ok, status: String(res.head.status), ms: performance.now() - t0 };
    } catch (err) {
      // A rejected push surfaces here: this node lost the race.
      const msg = String((err as Error)?.message ?? err);
      return {
        ok: false,
        status: /unexpected existing row state/.test(msg) ? "GUARD" : "ERR",
        ms: performance.now() - t0,
      };
    }
  };

  const [a, b] = await Promise.all([acquire(net0, "n0"), acquire(net1, "n1")]);
  const wins = (a.ok ? 1 : 0) + (b.ok ? 1 : 0);
  counts[wins === 2 ? "double" : wins === 1 ? "single" : "none"]++;
  for (const r of [a, b]) if (r.ok) winMs.push(r.ms);
  console.log(
    `iter ${i}: n0=${a.status}(${a.ms.toFixed(0)}ms) n1=${b.status}(${b.ms.toFixed(0)}ms) -> ${wins} winner(s)` +
      (wins !== 1 ? "  <-- BAD" : ""),
  );

  await net1.stop().catch(() => {});
}

await net0.stop().catch(() => {});
winMs.sort((x, y) => x - y);
console.log(`\n=== EXPERIMENT E RESULT (guarded, unsharded, n=${N}) ===`);
console.log(`single winner: ${counts.single}`);
console.log(`double wins:   ${counts.double}   (experiment B, unguarded: 50/50)`);
console.log(`no winner:     ${counts.none}`);
console.log(`winning acquire latency median: ${winMs[Math.floor(winMs.length / 2)]?.toFixed(0) ?? "?"}ms`);

for (const name of [`${PREFIX}${ORIGIN}`, `${PREFIX}timeouts`]) {
  console.log(`[cleanup] ${name} -> ${(await api("DELETE", `/databases/${name}`)).status}`);
}
process.exit(0);
