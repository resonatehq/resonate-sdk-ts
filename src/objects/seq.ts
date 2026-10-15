// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// The SEQUENCER protocol extension, emulated as network middleware (the same
// seam as serial.ts's coordinator — this logic belongs inside the server, and
// the runtime above it would not change if the server took over).
//
// One new create mode, keyed by two tags:
//
//   resonate:seq    = <key>   — the server ASSIGNS the promise id
//                               `<key>:m{n}`, n = the key's dense counter,
//                               atomically with the create, and stamps the
//                               origin tags (origin=key, branch=id,
//                               parent=key).
//   resonate:seq-ik = <ik>    — idempotency: the server remembers ik → id
//                               (bounded window in a real server), so a
//                               sender retry re-lands on the SAME id and the
//                               idempotent create absorbs it. Exactly-once
//                               append with no client-side adopt scan.
//
// What this dissolves for the chain object: the head probe (enqueue is one
// RPC), CAS retries and their unfairness under contention, the adopt-window
// caveat, and the retention hazard (the counter is server state — GC may
// reap old slots without senders re-deriving the head from the id space).
// Because assigned ids are dense, the predecessor stays arithmetic, so the
// serial extension's S2 stamp is subsumed and S1's dispatch gating becomes
// an optional add-on rather than a prerequisite: dispatch, tasks, and
// serialization-by-awaited-predecessor remain completely stock.

import type { Network } from "../network/network.js";
import type { Message, Request, Response } from "../network/types.js";
import { randomUUID } from "../platform.js";
import * as util from "../util.js";

export class SequencerNetwork implements Network {
  /** key → promise of the next unassigned sequence number. The successor is
   * installed SYNCHRONOUSLY on every allocation, so concurrent appends are
   * linearized per key — the emulation of the server's atomic counter. A real
   * server persists it; the emulation recovers it lazily by probing the id
   * space once per key per process. */
  private nexts = new Map<string, Promise<number>>();
  /** `${key}|${ik}` → assigned id (installed synchronously, so concurrent
   * same-ik retries share one allocation). A real server bounds this window. */
  private assigned = new Map<string, Promise<string>>();

  constructor(private inner: Network) {}

  get unicast() {
    return this.inner.unicast;
  }
  get anycast() {
    return this.inner.anycast;
  }
  match(target: string): string {
    return this.inner.match(target);
  }
  init(): Promise<void> {
    return this.inner.init();
  }
  stop(): Promise<void> {
    return this.inner.stop();
  }
  recv(cb: (msg: Message) => void): void {
    this.inner.recv(cb);
  }

  send = (<K extends Request["kind"]>(req: Extract<Request, { kind: K }>): Promise<Extract<Response, { kind: K }>> => {
    const r = req as Request;
    const d =
      r.kind === "promise.create"
        ? r.data
        : r.kind === "task.fence" && r.data.action.kind === "promise.create"
          ? r.data.action.data
          : undefined;
    const key = d?.tags?.["resonate:seq"];
    if (d && key) {
      return this.assign(key, d).then(() => this.inner.send(req));
    }
    return this.inner.send(req);
  }) as Network["send"];

  private assign(key: string, d: { id: string; tags: Record<string, string> }): Promise<void> {
    const ik = d.tags["resonate:seq-ik"];
    const dedupKey = ik ? `${key}|${ik}` : undefined;

    let idP = dedupKey ? this.assigned.get(dedupKey) : undefined;
    if (!idP) {
      idP = this.next(key).then((n) => `${key}:m${n}`);
      if (dedupKey) this.assigned.set(dedupKey, idP);
    }

    return idP.then((id) => {
      // Server-side stamping: the sender never writes the id or the lineage
      // tags, which also closes the key-injection surface at this seam.
      d.id = id;
      d.tags["resonate:origin"] = key;
      d.tags["resonate:branch"] = id;
      d.tags["resonate:parent"] = key;
    });
  }

  /** Allocate the key's next sequence number. Read-and-replace of the chain
   * tail is synchronous, so allocations are dense and race-free. */
  private next(key: string): Promise<number> {
    const mine = this.nexts.get(key) ?? this.recover(key);
    this.nexts.set(
      key,
      mine.then((n) => n + 1),
    );
    return mine;
  }

  /** First free sequence number for a key this process has not seen: gallop
   * the id space (stands in for the server's persisted counter). */
  private async recover(key: string): Promise<number> {
    if (!(await this.exists(key, 0))) return 0;
    let step = 1;
    let prev = 0;
    while (await this.exists(key, prev + step)) {
      prev += step;
      step *= 2;
    }
    let a = prev + 1;
    let b = prev + step;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (await this.exists(key, mid)) a = mid + 1;
      else b = mid;
    }
    return a;
  }

  private async exists(key: string, n: number): Promise<boolean> {
    const res = await this.inner.send({
      kind: "promise.get",
      head: { corrId: randomUUID(), version: util.VERSION },
      data: { id: `${key}:m${n}` },
    });
    return res.head.status === 200;
  }
}
