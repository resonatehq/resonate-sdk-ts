// Experiment C: can a server-side transaction give the CAS the sync driver
// cannot? Two candidates, raced head to head on one Turso Cloud database:
//
//   A. @tursodatabase/serverless — Hrana v3 pipeline with batons; the session
//      runs BEGIN IMMEDIATE .. COMMIT on the server.
//   B. @libsql/client — client.transaction("write"), same wire protocol via
//      the libsql SDK.
//
// Per iteration both contenders read version, compare to 0, write version 1
// with their pid, and commit. A sound serialization point yields exactly one
// winner, every time.
//
// Env: TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP_TOKEN, TURSO_GROUP.
// Run:  npx tsx experiments/exp-c.ts --n 20

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
const DB = "cas-probe";
const URL = `libsql://${DB}-${ORG}.${REGION}.turso.io`;

// -- provision ---------------------------------------------------------------

const create = await fetch(`https://api.turso.tech/v1/organizations/${ORG}/databases`, {
  method: "POST",
  headers: { authorization: `Bearer ${PLATFORM}`, "content-type": "application/json" },
  body: JSON.stringify({ name: DB, group: GROUP }),
});
console.log(`[provision] ${DB} -> ${create.status}`);

// -- contenders --------------------------------------------------------------

type Outcome = { pid: string; won: boolean; note: string; ms: number };

/** Hrana session CAS: BEGIN IMMEDIATE, read-compare-write, COMMIT. */
async function hranaCas(id: string, pid: string): Promise<Outcome> {
  const { Session } = await import("@tursodatabase/serverless");
  const session = new Session({ url: URL, authToken: TOKEN });
  const t0 = performance.now();
  try {
    await session.sequence("BEGIN IMMEDIATE");
    const result: any = await session.execute("SELECT version FROM tasks WHERE id = ?", [id]);
    const version = Number(result.rows?.[0]?.version ?? Number.NaN);
    if (version !== 0) {
      await session.sequence("ROLLBACK");
      return { pid, won: false, note: `saw version ${version}`, ms: performance.now() - t0 };
    }
    await session.execute("UPDATE tasks SET version = 1, pid = ? WHERE id = ?", [pid, id]);
    await session.sequence("COMMIT");
    return { pid, won: true, note: "committed", ms: performance.now() - t0 };
  } catch (err) {
    return { pid, won: false, note: String((err as Error)?.message ?? err).slice(0, 80), ms: performance.now() - t0 };
  } finally {
    await session.close().catch(() => {});
  }
}

/** libsql client CAS via transaction("write"). */
async function libsqlCas(id: string, pid: string): Promise<Outcome> {
  const mod: any = await import("@libsql/client");
  const client = mod.createClient({ url: URL, authToken: TOKEN });
  const t0 = performance.now();
  try {
    const tx = await client.transaction("write");
    try {
      const rs = await tx.execute({ sql: "SELECT version FROM tasks WHERE id = ?", args: [id] });
      const version = Number(rs.rows[0]?.version ?? Number.NaN);
      if (version !== 0) {
        await tx.rollback();
        return { pid, won: false, note: `saw version ${version}`, ms: performance.now() - t0 };
      }
      await tx.execute({ sql: "UPDATE tasks SET version = 1, pid = ? WHERE id = ?", args: [pid, id] });
      await tx.commit();
      return { pid, won: true, note: "committed", ms: performance.now() - t0 };
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  } catch (err) {
    return { pid, won: false, note: String((err as Error)?.message ?? err).slice(0, 80), ms: performance.now() - t0 };
  } finally {
    client.close();
  }
}

// -- harness -----------------------------------------------------------------

async function race(label: string, cas: (id: string, pid: string) => Promise<Outcome>): Promise<void> {
  const { Session } = await import("@tursodatabase/serverless");
  const setup = new Session({ url: URL, authToken: TOKEN });
  await setup.sequence("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, version INTEGER NOT NULL, pid TEXT)");

  const counts = { double: 0, single: 0, none: 0 };
  const winLatencies: number[] = [];
  for (let i = 0; i < N; i++) {
    const id = `${label}-${Date.now().toString(36)}-${i}`;
    await setup.execute("INSERT INTO tasks (id, version) VALUES (?, 0)", [id]);
    const [a, b] = await Promise.all([cas(id, "n0"), cas(id, "n1")]);
    const wins = (a.won ? 1 : 0) + (b.won ? 1 : 0);
    if (wins === 2) counts.double++;
    else if (wins === 1) counts.single++;
    else counts.none++;
    for (const o of [a, b]) if (o.won) winLatencies.push(o.ms);
    console.log(
      `[${label}] iter ${i}: n0=${a.won ? "WON" : `lost(${a.note})`} ${a.ms.toFixed(0)}ms | n1=${b.won ? "WON" : `lost(${b.note})`} ${b.ms.toFixed(0)}ms -> ${wins} winner(s)${wins !== 1 ? "  <-- BAD" : ""}`,
    );
  }
  await setup.close().catch(() => {});
  winLatencies.sort((x, y) => x - y);
  const median = winLatencies[Math.floor(winLatencies.length / 2)]?.toFixed(0) ?? "?";
  console.log(
    `[${label}] RESULT n=${N}: single=${counts.single} double=${counts.double} none=${counts.none}; winner latency median=${median}ms\n`,
  );
}

await race("hrana", hranaCas);
await race("libsql", libsqlCas);

const del = await fetch(`https://api.turso.tech/v1/organizations/${ORG}/databases/${DB}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${PLATFORM}` },
});
console.log(`[cleanup] ${DB} -> ${del.status}`);
process.exit(0);
