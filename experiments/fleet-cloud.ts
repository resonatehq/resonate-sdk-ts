// A cloud-backed Resonate node: origins AND the timer index live in Turso
// Cloud, and databases are created on first touch via the platform API —
// the create-if-missing arrangement turso.md describes.
//
// Env: TURSO_PLATFORM_TOKEN, TURSO_ORG, TURSO_GROUP_TOKEN, TURSO_GROUP.
// Run:  UV_THREADPOOL_SIZE=64 npx tsx experiments/fleet-cloud.ts --id order-42 --amount 99

import { mkdirSync, rmSync } from "node:fs";
import { Codec, ConsoleLogger, type Context, NoopEncryptor, Resonate } from "../src/index.js";
import { type TursoDriver, TursoNetwork, tursoSyncDriver } from "../src/network/turso/index.js";

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
const ID = arg("id", "order-42");
const AMOUNT = Number(arg("amount", "99"));

const dir = "/tmp/fleet-cloud";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

/** Create the remote database if it does not exist yet, then open it. */
function createOnOpen(inner: TursoDriver): TursoDriver {
  const known = new Set<string>();
  return {
    async open(name) {
      if (!known.has(name)) {
        const t0 = performance.now();
        const res = await fetch(`https://api.turso.tech/v1/organizations/${ORG}/databases`, {
          method: "POST",
          headers: { authorization: `Bearer ${PLATFORM}`, "content-type": "application/json" },
          body: JSON.stringify({ name, group: GROUP }),
        });
        // 409 means it already exists — exactly what we want.
        console.log(`[provision] ${name} -> ${res.status} in ${Math.round(performance.now() - t0)}ms`);
        known.add(name);
      }
      return inner.open(name);
    },
  };
}

const driver = createOnOpen(
  tursoSyncDriver({
    dir,
    url: (name) => `libsql://${name}-${ORG}.${REGION}.turso.io`,
    authToken: TOKEN,
  }),
);

const resonate = new Resonate({
  pid: "cloud-node",
  network: new TursoNetwork({
    driver,
    prefix: "fleet-",
    timeoutDatabase: "timeouts",
    pid: "cloud-node",
    tickMs: 100,
    retryTimeout: 5_000,
    logger: new ConsoleLogger("warn"),
  }),
});

async function charge(_ctx: Context, amount: number): Promise<string> {
  console.log(`[cloud-node] charge(${amount})`);
  return `CH-${amount}`;
}
async function ship(_ctx: Context, ref: string): Promise<string> {
  console.log(`[cloud-node] ship(${ref})`);
  return `SHIP-${ref}`;
}
resonate.register("charge", charge);
resonate.register("ship", ship);
resonate.register("order", function* (ctx: Context, amount: number): any {
  const ref = yield* ctx.run(charge, amount);
  yield* ctx.sleep(200);
  const shipment = yield* ctx.run(ship, ref);
  return { ref, shipment };
});

const codec = new Codec(new NoopEncryptor());
const t0 = Date.now();
await resonate.beginRun(ID, "order", AMOUNT);
console.log(`[cloud-node] beginRun(${ID}) accepted at +${Date.now() - t0}ms`);

for (;;) {
  const p: any = await resonate.promises.get(ID).catch(() => undefined);
  if (p && p.state !== "pending") {
    console.log(`[cloud-node] ${ID} ${p.state} in ${Date.now() - t0}ms: ${JSON.stringify(codec.decode(p.value))}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`\nTurso Cloud now holds: fleet-${ID} (this workflow) and fleet-timeouts (the timer index).`);
process.exit(0);
