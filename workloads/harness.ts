// =============================================================================
// WORKLOAD HARNESS
// =============================================================================
//
// The canonical workloads (`index1.ts`–`index3.ts`, copied from
// `resonate-specification/work/ts`) drive the SDK over `S3Network` — no
// server anywhere — and this harness records the conversation for the
// specification's linearizability checkers.
//
// The tap point is `Network.send` itself, the same seam the spec's Go
// recorder uses: every request the SDK makes goes through exactly one
// method, so a decorator sees the whole conversation with no proxy and no
// risk of recording something the SDK did not send. Each request is stamped
// with `resonate:debug_time` from a monotonized wall clock — the same clock
// the engines derive deadlines from, which is the checkers' one-clock rule.
//
// Two files per recording, the formats of `resonate-specification/valid`:
//
//   <prefix>.ndjson    {kind, now, req, res} ordered by (now, return) —
//                      for lincheck (does some schedule explain THIS order)
//   <prefix>.history   + {client, call, return} in return order — for
//                      conccheck (does some schedule explain SOME order
//                      consistent with the real intervals).
//
// The client of a row is its BRANCH. A branch is the sibling group one
// executing invocation drives — a dispatched child starts its own branch
// (its own executor), a local child rides its parent's — so branches are
// the workload's real sequential threads, and labeling rows by them makes
// a history readable per-execution. porcupine only requires that a client
// not overlap itself (its search runs on the intervals, so the labels are
// interpretability, not checking power), and a branch label CAN self-
// overlap in wall time — the driver's reads interleave with the root's
// executor, heartbeats belong to no branch — so rows are laned WITHIN
// their label: `wf`, and `wf~2` for the rare spill.
//
// Sweep transitions never pass through `send`, so they are not in the file —
// they are exactly the internal steps the checkers recover by search.
//
// S3_CHAOS=1 wraps the buckets in a lying store (lost acknowledgments,
// vanished writes, delayed answers; seed with S3_SEED). A 500 the network
// answers under chaos is a PENDING op — the checkers leave it free and
// report the count.

import { appendFileSync, writeFileSync } from "node:fs";
import type { Network } from "../src/network/network.js";
import { MemoryBucket, type S3Bucket, S3Network } from "../src/network/s3/index.js";
import type { Request, Response } from "../src/network/types.js";

// -----------------------------------------------------------------------------
// CLI helpers, verbatim from the spec's workloads.
// -----------------------------------------------------------------------------

export function flag(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function positionals(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith("--"));
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
        const result = await bucket.put(key, body, condition);
        if (result.kind === "landed") {
          await new Promise((r) => setTimeout(r, 1 + Math.floor(rand() * 20)));
          return { kind: "unknown", error: "chaos: answer lost after landing" };
        }
        return result;
      }
      if (roll < 0.25) {
        await new Promise((r) => setTimeout(r, 1 + Math.floor(rand() * 10)));
        return { kind: "unknown", error: "chaos: request lost before landing" };
      }
      return bucket.put(key, body, condition);
    },
  };
}

// -----------------------------------------------------------------------------
// The recorder.
// -----------------------------------------------------------------------------

interface Row {
  kind: string;
  now: number;
  req: unknown;
  res: Response;
  call: number;
  return: number;
}

export class Recorder {
  readonly network: Network;
  private readonly rows: Row[] = [];
  private readonly started = process.hrtime.bigint();
  private stamp = 0;

  constructor(inner: S3Network) {
    const clock = (): number => {
      // Wall clock, monotonized: the engines derive deadlines from
      // Date.now(), and the one-clock rule wants request stamps on the
      // same axis, never decreasing.
      this.stamp = Math.max(this.stamp, Date.now());
      return this.stamp;
    };
    const rows = this.rows;
    const started = this.started;
    this.network = {
      get unicast() {
        return inner.unicast;
      },
      get anycast() {
        return inner.anycast;
      },
      match: (target) => inner.match(target),
      init: () => inner.init(),
      stop: () => inner.stop(),
      recv: (cb) => inner.recv(cb),
      send: async <K extends Request["kind"]>(req: Extract<Request, { kind: K }>) => {
        const now = clock();
        const stamped = { ...req, head: { ...req.head, "resonate:debug_time": now } } as typeof req;
        const call = Number(process.hrtime.bigint() - started);
        const res = await inner.send(stamped);
        rows.push({
          kind: req.kind,
          now,
          req: stamped.data,
          res,
          call,
          return: Number(process.hrtime.bigint() - started),
        });
        return res;
      },
    };
  }

  /** 500-answered ops so far — the pending count the verdict travels with. */
  pending(): number {
    return this.rows.filter((r) => r.res.head.status === 500).length;
  }

  /**
   * The branch a row belongs to — the executing invocation's sibling group.
   *
   * Creates carry it on the wire (`resonate:branch`), which seeds a map from
   * id to branch; every other request is labeled by its primary id's entry.
   * A task op on X is issued by X's executor, whose branch is X's own
   * branch — for a dispatched X that is X itself, which is also exactly what
   * X's create tag says, so the map answers for both promise and task rows.
   * Heartbeats are pid-wide and belong to no branch.
   */
  private branchOf(): (r: Row) => string {
    const branches = new Map<string, string>();
    for (const r of [...this.rows].sort((a, b) => a.call - b.call)) {
      const d = r.req as {
        id?: string;
        tags?: Record<string, string>;
        action?: { data?: { id?: string; tags?: Record<string, string> } };
      };
      if (r.kind === "promise.create" && d.id !== undefined) {
        branches.set(d.id, d.tags?.["resonate:branch"] ?? d.id);
      }
      if (r.kind === "task.create" && d.action?.data?.id !== undefined) {
        branches.set(d.action.data.id, d.action.data.tags?.["resonate:branch"] ?? d.action.data.id);
      }
    }
    return (r: Row): string => {
      if (r.kind === "task.heartbeat") return "heartbeat";
      const d = r.req as { id?: string; awaited?: string; action?: { data?: { id?: string } } };
      const id = r.kind === "task.create" ? d.action?.data?.id : (d.id ?? d.awaited);
      if (id === undefined) return "client";
      return branches.get(id) ?? id;
    };
  }

  /** Write `<prefix>.ndjson` and `<prefix>.history`. */
  flush(prefix: string): void {
    const ndjson = [...this.rows].sort((a, b) => a.now - b.now || a.return - b.return);
    const history = [...this.rows].sort((a, b) => a.return - b.return);

    // Lane rows by branch; porcupine requires a client not to overlap
    // itself, and a branch label can (driver reads interleaving the root's
    // executor), so overlap spills into `<branch>~2`, `<branch>~3`, ....
    const branch = this.branchOf();
    const busyUntil = new Map<string, number>();
    const laneOf = new Map<Row, string>();
    let spills = 0;
    for (const r of [...this.rows].sort((a, b) => a.call - b.call)) {
      const label = branch(r);
      let lane = label;
      for (let k = 2; (busyUntil.get(lane) ?? 0) > r.call; k++) {
        lane = `${label}~${k}`;
      }
      if (lane !== label) spills += 1;
      busyUntil.set(lane, r.return);
      laneOf.set(r, lane);
    }
    // conccheck's `client` field is numeric; the lane's name travels in a
    // `lane` field the decoder ignores, for humans reading the file.
    const laneIndex = new Map<string, number>();
    for (const lane of laneOf.values()) {
      if (!laneIndex.has(lane)) laneIndex.set(lane, laneIndex.size);
    }

    writeFileSync(`${prefix}.ndjson`, "");
    writeFileSync(`${prefix}.history`, "");
    for (const r of ndjson) {
      appendFileSync(`${prefix}.ndjson`, `${JSON.stringify({ kind: r.kind, now: r.now, req: r.req, res: r.res })}\n`);
    }
    for (const r of history) {
      const lane = laneOf.get(r) ?? "client";
      appendFileSync(
        `${prefix}.history`,
        `${JSON.stringify({ ...r, req: r.req, res: r.res, client: laneIndex.get(lane) ?? 0, lane })}\n`,
      );
    }
    console.log(
      `\ntrace           = ${this.rows.length} events, pending=${this.pending()}, lanes=${laneIndex.size} (${spills} overlap spills) -> ${prefix}.ndjson, ${prefix}.history`,
    );
  }
}

// -----------------------------------------------------------------------------
// Wiring: an S3Network over in-memory buckets, recorded when S3_TRACE is set.
// -----------------------------------------------------------------------------

export interface Rig {
  network: Network;
  /** The undecorated network, for out-of-band queries (counts). */
  raw: S3Network;
  recorder?: Recorder;
  /** Flush the recording (if any) and stop the network. */
  done(): Promise<void>;
}

export function rig(): Rig {
  const seed = Number(process.env.S3_SEED ?? 42);
  const rand = mulberry32(seed);
  const chaos = process.env.S3_CHAOS === "1";
  const wrap = (b: S3Bucket) => (chaos ? chaotic(b, rand) : b);
  const raw = new S3Network({
    workflows: wrap(new MemoryBucket()),
    timeouts: wrap(new MemoryBucket()),
    tickMs: 50,
  });

  const prefix = process.env.S3_TRACE;
  if (!prefix) {
    return { network: raw, raw, done: async () => void (await raw.stop()) };
  }
  const recorder = new Recorder(raw);
  return {
    network: recorder.network,
    raw,
    recorder,
    done: async () => {
      recorder.flush(prefix);
      await raw.stop();
    },
  };
}

// -----------------------------------------------------------------------------
// Counts: the cheapest conformance check in the spec's workload folder.
// -----------------------------------------------------------------------------

let corr = 1000;

export async function counts(raw: S3Network, origin: string): Promise<{ promises: number; tasks: number }> {
  const head = () => ({ corrId: `count${++corr}`, version: "count", "resonate:origin": origin });
  const promises = await raw.send({ kind: "promise.search", head: head(), data: { limit: 1000 } });
  const tasks = await raw.send({ kind: "task.search", head: head(), data: { limit: 1000 } });
  return {
    promises: promises.head.status === 200 ? (promises.data as { promises: unknown[] }).promises.length : -1,
    tasks: tasks.head.status === 200 ? (tasks.data as { tasks: unknown[] }).tasks.length : -1,
  };
}
