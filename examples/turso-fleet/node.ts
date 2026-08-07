// A Resonate node with an HTTP front door, sized for a sharded fleet.
//
//   POST /invoke   { id, func, args? }   kick off (or attach to) a workflow
//   GET  /get/:id                        read a workflow's state and result
//   GET  /health                         who am I, what do I own
//
// Every node runs the same code and registers the same functions. What
// distinguishes them is `--shard i --of n` and `--dir`.
//
// OWNERSHIP. `ownerOf(origin, n)` — 32-bit FNV-1a of the origin, modulo n —
// decides which node owns a workflow. Two places consult it, and they must
// agree or the fleet is incoherent:
//
//   * the SDK, to sweep only its own timers out of the tenant index;
//   * this HTTP layer, to forward a request for someone else's workflow.
//
// That is why the hash lives in the SDK and is imported here rather than
// reimplemented. One function, one answer.
//
// STORAGE. Two kinds, deliberately kept apart.
//
//   Origin databases live in this node's own `--dir`. Under static sharding a
//   node only ever touches origins it owns, so nothing else needs to reach
//   them, and `tursoLocalDriver` — which takes an exclusive file lock — is
//   exactly right.
//
//   The timer index lives in `--timers`, shared by the whole fleet. It has to
//   be: it is the one place a node learns that work exists at all. That rules
//   out the local driver (its file lock would stop the second node dead), so
//   the tenant database gets its own driver — a `file:` libSQL database, which
//   uses ordinary SQLite locking and is shared across processes. In a real
//   deployment this would be one Turso Cloud database instead.
//
// Run two of them:
//   npx tsx examples/turso-fleet/node.ts --port 8101 --shard 0 --of 2 --dir /tmp/n0 --timers /tmp/timers --peers http://127.0.0.1:8101,http://127.0.0.1:8102
//   npx tsx examples/turso-fleet/node.ts --port 8102 --shard 1 --of 2 --dir /tmp/n1 --timers /tmp/timers --peers http://127.0.0.1:8101,http://127.0.0.1:8102

import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Codec, ConsoleLogger, type Context, NoopEncryptor, Resonate } from "../../src/index.js";
import { libsqlDriver, originOf, ownerOf, TursoNetwork, tursoLocalDriver } from "../../src/network/turso/index.js";

// -- config -----------------------------------------------------------------

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? fallback : process.argv[i + 1];
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

const port = Number(arg("port"));
const shardIndex = Number(arg("shard"));
const shardCount = Number(arg("of"));
const dir = arg("dir");
const timers = arg("timers");
const peers = arg("peers", "").split(",").filter(Boolean);
const me = `node-${shardIndex}`;

mkdirSync(dir, { recursive: true });
mkdirSync(timers, { recursive: true });

// -- the workflows ----------------------------------------------------------

async function charge(_ctx: Context, amount: number): Promise<string> {
  console.log(`[${me}] charge(${amount})`);
  return `CH-${amount}`;
}

async function ship(_ctx: Context, ref: string): Promise<string> {
  console.log(`[${me}] ship(${ref})`);
  return `SHIP-${ref}`;
}

const resonate = new Resonate({
  pid: me,
  network: new TursoNetwork({
    driver: tursoLocalDriver({ dir }),
    // Shared by the fleet, so it cannot use the file-locking local driver.
    timeoutDriver: libsqlDriver({ url: `file:${timers}/` }),
    prefix: "fleet-",
    timeoutDatabase: "timeouts",
    pid: me,
    tickMs: 100,
    retryTimeout: 5_000,
    // The whole point: sweep only the timers of origins this node owns.
    shard: { index: shardIndex, count: shardCount },
    // A tick that fails does so quietly otherwise, and a fleet whose sweeper
    // is broken looks exactly like a fleet with nothing to do.
    logger: new ConsoleLogger("warn"),
  }),
});

resonate.register("charge", charge);
resonate.register("ship", ship);
// A workflow whose durable sleep is long enough to watch: while it is parked,
// its timer sits in the shared index, tagged with its origin's hash.
resonate.register("wait", function* (ctx: Context, ms: number): any {
  console.log(`[${me}] wait(${ms}) parking`);
  yield* ctx.sleep(ms);
  console.log(`[${me}] wait(${ms}) resumed`);
  return { wokeOn: me, ms };
});

resonate.register("order", function* (ctx: Context, amount: number): any {
  const ref = yield* ctx.run(charge, amount);
  yield* ctx.sleep(200); // a durable pause, so the timer path is exercised
  const shipment = yield* ctx.run(ship, ref);
  return { ref, shipment };
});

// -- HTTP -------------------------------------------------------------------

/** Matches the client's default, so `/get` can decode a value it did not encode. */
const codec = new Codec(new NoopEncryptor());

function owns(id: string): boolean {
  return ownerOf(originOf(id), shardCount) === shardIndex;
}

/** Forward verbatim to the node that owns this workflow. */
async function forward(id: string, path: string, init: RequestInit): Promise<Response> {
  const owner = ownerOf(originOf(id), shardCount);
  const peer = peers[owner];
  if (!peer) throw new Error(`no peer configured for shard ${owner}`);
  return await fetch(`${peer}${path}`, init);
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      return send(res, 200, { node: me, shard: shardIndex, of: shardCount, dir, timers, peers });
    }

    // POST /invoke  { id, func, args? }
    if (req.method === "POST" && url.pathname === "/invoke") {
      const { id, func, args = [] } = await body(req);
      if (typeof id !== "string" || typeof func !== "string") {
        return send(res, 400, { error: "id and func are required" });
      }
      if (!owns(id)) {
        // Not ours. The owner has the databases; hand it over rather than
        // creating a second, divergent copy of this workflow here.
        const upstream = await forward(id, "/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, func, args }),
        });
        return send(res, upstream.status, {
          ...((await upstream.json()) as Record<string, unknown>),
          forwardedBy: me,
        });
      }
      // beginRun returns as soon as the workflow is durably recorded; the
      // result is fetched separately via /get.
      await resonate.beginRun(id, func, ...args);
      return send(res, 202, { id, owner: me, shard: shardIndex, status: "accepted" });
    }

    // GET /get/:id
    if (req.method === "GET" && url.pathname.startsWith("/get/")) {
      const id = decodeURIComponent(url.pathname.slice("/get/".length));
      if (!owns(id)) {
        const upstream = await forward(id, `/get/${encodeURIComponent(id)}`, { method: "GET" });
        return send(res, upstream.status, {
          ...((await upstream.json()) as Record<string, unknown>),
          forwardedBy: me,
        });
      }

      // Read the promise and decode it in place. Deliberately not
      // `resonate.get(id).result()`: that registers a listener and waits to be
      // told, which is the one thing this network does not do well across
      // processes. A read is enough — the promise record already carries the
      // settled value, and a Turso read is side-effect free by projection, so
      // polling this route costs nothing a push would have saved.
      const promise = await resonate.promises.get(id).catch(() => undefined);
      if (!promise) {
        return send(res, 404, { id, owner: me, error: "no such workflow" });
      }
      if (promise.state === "pending") {
        return send(res, 200, { id, owner: me, state: "pending" });
      }
      const value = codec.decode(promise.value);
      const key = promise.state === "resolved" ? "result" : "error";
      return send(res, 200, { id, owner: me, state: promise.state, [key]: value ?? null });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err) });
  }
});

server.listen(port, () => {
  console.log(`[${me}] listening on :${port} — shard ${shardIndex} of ${shardCount}, dir ${dir}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void resonate.stop().then(() => process.exit(0));
  });
}
