// =============================================================================
// LINEARIZABILITY TRACE PRODUCER
// =============================================================================
//
// Drives `S3Network` and records the conversation in the trace format of
// `resonate-specification/valid/README.md`, so the recorded traffic can be
// judged by the specification's own checkers:
//
//   npx tsx scripts/s3-lintrace.ts out            # writes out.ndjson + out.history
//   lincheck  < out.ndjson                        # valid/porc: sequential order
//   conccheck < out.history                       # valid/porc: real intervals
//
// The rules of the format, honored here:
//
//   * One clock. Every request carries `resonate:debug_time` from a counter
//     that only advances, and the deadlines the promises carry come from the
//     same counter — the checkers judge timeouts against `now`, not wall
//     clock. Concurrent requests share instants in batches; ties are legal
//     (the specification says non-decreasing).
//   * Internal steps are NOT in the file. The network's sweep never runs
//     (tickMs is set past the run), so the only hidden steps are the resume
//     drains a settle performs — exactly what the checkers recover by
//     existential search (their R4).
//   * No schedules — the loader refuses traces mentioning them, because the
//     specification leaves `nextCron` opaque.
//
// The scenario per client is a backbone of well-formed workflow traffic —
// create, acquire, fence, suspend on a pending promise, settle it (the
// hidden resume), re-acquire, fulfill — plus the perturbations the porc
// README says captures never exercise: stale versions, missing ids,
// double-settles, a listener with a bad address, halt/continue, release,
// heartbeat. Sequential mode runs the clients one after another; concurrent
// mode overlaps them (each client owns its origin, so the checker's
// per-origin partitioning stays sound).
//
// Optionally set S3_LIVE_ENDPOINT to record against a real S3 API through
// `awsBucket` instead of MemoryBucket — same trace format, same checkers.

import { appendFileSync, writeFileSync } from "node:fs";
import { awsBucket, MemoryBucket, type S3Bucket, S3Network } from "../src/network/s3/index.js";
import type { Request, Response } from "../src/network/types.js";
import { VERSION } from "../src/util.js";

const out = process.argv[2] ?? "s3-trace";
const mode = process.argv[3] === "concurrent" ? "concurrent" : process.argv[3] === "contend" ? "contend" : "sequential";
const CLIENTS = Number(process.env.TRACE_CLIENTS ?? (mode === "sequential" ? 6 : 4));
// TRACE_CHAOS=1 makes the store LIE on demand: some puts land but report an
// unknowable outcome, some report an injected transient error without
// landing. The update loop's recognition pass (re-read, byte-compare) has to
// absorb both — and the recorded responses must STILL linearize. Seeded, so
// a failure reproduces.
const CHAOS = process.env.TRACE_CHAOS === "1";

// -----------------------------------------------------------------------------
// The clock: monotone, shared by request stamps and promise deadlines.
// -----------------------------------------------------------------------------

let instant = 1_000_000;
let batch = 0;
const BATCH = 4;
function tick(): number {
  batch += 1;
  if (batch % BATCH === 0) instant += 10 + (batch % 37);
  return instant;
}

// -----------------------------------------------------------------------------
// The recorder: the tap point is `send` itself.
// -----------------------------------------------------------------------------

interface Row {
  kind: string;
  now: number;
  req: unknown;
  res: unknown;
  client: number;
  call: number;
  return: number;
}

const rows: Row[] = [];
let corr = 0;
let ambiguous = 0;
const started = process.hrtime.bigint();

function recorder(net: S3Network, client: number) {
  return async <K extends Request["kind"]>(kind: K, data: Extract<Request, { kind: K }>["data"]) => {
    corr += 1;
    const now = tick();
    const req = {
      kind,
      head: { corrId: `t${corr}`, version: VERSION, "resonate:debug_time": now },
      data,
    } as Extract<Request, { kind: K }>;
    const call = Number(process.hrtime.bigint() - started);
    const res = (await net.send(req)) as Response;
    const ret = Number(process.hrtime.bigint() - started);
    // A 500 is the network refusing to guess: the write may or may not have
    // applied, and the machine has no transition answering 500 — so the op
    // is really PENDING, which the spec's trace format cannot yet express.
    // It is recorded (the file stays an honest tap) and counted; a trace
    // containing any is not checkable until the format learns pending ops.
    if (res.head.status === 500) ambiguous += 1;
    rows.push({ kind, now, req: data, res, client, call, return: ret });
    return res;
  };
}

// -----------------------------------------------------------------------------
// The scenario: one client, one origin.
// -----------------------------------------------------------------------------

const TARGET = "poll://any@default";

async function scenario(net: S3Network, client: number) {
  const send = recorder(net, client);
  const wf = `o${client}`;
  const horizon = () => instant + 600_000;

  // A workflow is born addressed, so a task exists to drive.
  await send("promise.create", {
    id: wf,
    timeoutAt: horizon(),
    param: { data: "in" },
    tags: { "resonate:target": TARGET },
  });
  // Idempotent replay of the create, and a read.
  await send("promise.create", {
    id: wf,
    timeoutAt: horizon(),
    param: { data: "other" },
    tags: { "resonate:target": TARGET },
  });
  await send("promise.get", { id: wf });
  // A stale acquire (wrong version) and the real one.
  await send("task.acquire", { id: wf, version: 7, pid: `p${client}`, ttl: 300_000 });
  await send("task.acquire", { id: wf, version: 0, pid: `p${client}`, ttl: 300_000 });
  // Fenced child create, then a fence with a stale version.
  await send("task.fence", {
    id: wf,
    version: 1,
    action: {
      kind: "promise.create",
      head: { corrId: `t${++corr}`, version: VERSION },
      data: { id: `${wf}.child`, timeoutAt: horizon(), param: { data: "arg" }, tags: {} },
    },
  });
  await send("task.fence", {
    id: wf,
    version: 0,
    action: {
      kind: "promise.create",
      head: { corrId: `t${++corr}`, version: VERSION },
      data: { id: `${wf}.stale`, timeoutAt: horizon(), param: {}, tags: {} },
    },
  });
  // An external promise to block on; a listener with a bad address first.
  await send("promise.create", {
    id: `${wf}.block`,
    timeoutAt: horizon(),
    param: {},
    tags: { "resonate:external": "true" },
  });
  await send("promise.register_listener", { awaited: `${wf}.block`, address: "poll://nowhere" });
  await send("promise.register_listener", { awaited: `${wf}.block`, address: `poll://uni@default/p${client}` });
  // Suspend awaiting the block; settling the block resumes the task — the
  // hidden internal step the checkers must reconstruct.
  await send("task.suspend", {
    id: wf,
    version: 1,
    actions: [
      {
        kind: "promise.register_callback",
        head: { corrId: `t${++corr}`, version: VERSION },
        data: { awaited: `${wf}.block`, awaiter: wf },
      },
    ],
  });
  await send("task.get", { id: wf });
  await send("promise.settle", { id: `${wf}.block`, state: "resolved", value: { data: "unblocked" } });
  await send("task.get", { id: wf });
  // Heartbeat against a task that is pending again (a no-op refresh miss).
  await send("task.heartbeat", { pid: `p${client}`, tasks: [{ id: wf, version: 1 }] });
  // Reclaim, halt and continue, release and reclaim again.
  await send("task.acquire", { id: wf, version: 1, pid: `p${client}`, ttl: 300_000 });
  await send("task.release", { id: wf, version: 2 });
  await send("task.halt", { id: wf });
  await send("task.continue", { id: wf });
  await send("task.acquire", { id: wf, version: 2, pid: `p${client}`, ttl: 300_000 });
  // Settle a promise that does not exist, then finish the workflow.
  await send("promise.settle", { id: `${wf}.ghost`, state: "resolved", value: {} });
  await send("task.fulfill", {
    id: wf,
    version: 3,
    action: {
      kind: "promise.settle",
      head: { corrId: `t${++corr}`, version: VERSION },
      data: { id: wf, state: "resolved", value: { data: "out" } },
    },
  });
  // A double settle after fulfillment, and the final reads.
  await send("promise.settle", { id: wf, state: "rejected", value: { data: "late" } });
  await send("promise.get", { id: wf });
  await send("task.get", { id: wf });
}

// -----------------------------------------------------------------------------
// The contention scenario: two clients on DIFFERENT networks race one origin
// through the shared buckets. Versions are discovered, not assumed — a lost
// race answers 409, which is itself an observation the checker must explain.
// -----------------------------------------------------------------------------

async function contention(net: S3Network, client: number, origin: string, rounds: number) {
  const send = recorder(net, client);
  const horizon = () => instant + 600_000;
  await send("promise.create", { id: origin, timeoutAt: horizon(), param: {}, tags: { "resonate:target": TARGET } });
  for (let i = 0; i < rounds; i++) {
    const got = await send("task.get", { id: origin });
    const version = got.head.status === 200 ? ((got.data as { task?: { version?: number } }).task?.version ?? 0) : 0;
    const acquired = await send("task.acquire", { id: origin, version, pid: `p${client}`, ttl: 300_000 });
    if (acquired.head.status !== 200) continue;
    const held = version + 1;
    await send("task.fence", {
      id: origin,
      version: held,
      action: {
        kind: "promise.create",
        head: { corrId: `t${++corr}`, version: VERSION },
        data: { id: `${origin}.c${client}r${i}`, timeoutAt: horizon(), param: {}, tags: {} },
      },
    });
    await send("task.release", { id: origin, version: held });
  }
}

// -----------------------------------------------------------------------------
// Chaos: a bucket that sometimes lies about writes.
// -----------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chaotic(bucket: S3Bucket, rand: () => number): S3Bucket {
  return {
    get: (key) => bucket.get(key),
    delete: (key) => bucket.delete(key),
    list: (prefix, opts) => bucket.list(prefix, opts),
    async put(key, body, condition) {
      const roll = rand();
      if (roll < 0.15) {
        // Landed, but the store's answer is lost: the caller must re-read
        // and recognize its own bytes.
        await bucket.put(key, body, condition);
        return { kind: "unknown", error: "chaos: answer lost after landing" };
      }
      if (roll < 0.25) {
        // Never landed, and the caller cannot tell that either.
        return { kind: "unknown", error: "chaos: request lost before landing" };
      }
      return bucket.put(key, body, condition);
    },
  };
}

// -----------------------------------------------------------------------------
// Run.
// -----------------------------------------------------------------------------

async function buckets(): Promise<{ workflows: S3Bucket; timeouts: S3Bucket }> {
  const endpoint = process.env.S3_LIVE_ENDPOINT;
  if (!endpoint) return { workflows: new MemoryBucket(), timeouts: new MemoryBucket() };
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  });
  const stamp = Date.now().toString(36);
  for (const bucket of [`lintrace-wf-${stamp}`, `lintrace-t-${stamp}`]) {
    await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
  }
  return {
    workflows: await awsBucket({ bucket: `lintrace-wf-${stamp}`, client }),
    timeouts: await awsBucket({ bucket: `lintrace-t-${stamp}`, client }),
  };
}

const raw = await buckets();
const rand = mulberry32(Number(process.env.TRACE_SEED ?? 42));
const shared = CHAOS ? { workflows: chaotic(raw.workflows, rand), timeouts: chaotic(raw.timeouts, rand) } : raw;

if (mode === "contend") {
  // Two networks — two processes as far as the store can tell — racing the
  // same origins through the same buckets.
  const a = new S3Network({ ...shared, tickMs: 3_600_000 });
  const b = new S3Network({ ...shared, tickMs: 3_600_000 });
  await a.init();
  await b.init();
  const pairs = Math.max(1, Math.floor(CLIENTS / 2));
  await Promise.all(
    Array.from({ length: pairs }, (_, p) => [
      contention(a, 2 * p, `shared${p}`, 5),
      contention(b, 2 * p + 1, `shared${p}`, 5),
    ]).flat(),
  );
  await a.stop();
  await b.stop();
} else {
  const net = new S3Network({ ...shared, tickMs: 3_600_000 });
  await net.init();
  if (mode === "sequential") {
    for (let c = 0; c < CLIENTS; c++) await scenario(net, c);
  } else {
    await Promise.all(Array.from({ length: CLIENTS }, (_, c) => scenario(net, c)));
  }
  await net.stop();
}

// The instant a request carried is the instant it executed under — it is
// NEVER rewritten (re-stamping detaches `now` from the createdAt/settledAt
// the responses carry, and the checkers rightly refuse that). The history
// keeps return order with true intervals; the ndjson must be non-decreasing
// in `now`, so it is ordered by (now, return) — within one instant, return
// order; across instants, clock order. The clock only advances, so each
// client's operations stay in program order.
const history = [...rows].sort((a, b) => a.return - b.return);
const ndjson = [...rows].sort((a, b) => a.now - b.now || a.return - b.return);

writeFileSync(`${out}.ndjson`, "");
writeFileSync(`${out}.history`, "");
for (const r of ndjson) {
  appendFileSync(`${out}.ndjson`, `${JSON.stringify({ kind: r.kind, now: r.now, req: r.req, res: r.res })}\n`);
}
for (const r of history) {
  appendFileSync(`${out}.history`, `${JSON.stringify(r)}\n`);
}
console.log(
  `${rows.length} events (${mode}, ${CLIENTS} clients, ambiguous=${ambiguous}) -> ${out}.ndjson, ${out}.history${
    ambiguous > 0 ? "  [NOT CHECKABLE: contains pending ops the trace format cannot express]" : ""
  }`,
);
