// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// Variant D — the OPTIMISTIC STATE CHAIN (considered and REJECTED as the
// durable-object primitive; kept because it is the cheapest possible encoding
// and the comparison is instructive).
//
// The object is a version chain o/{T}/{k}/v0, v1, v2 … where each version's
// PARAM carries the state after transition n. There are no handlers, no
// tasks, no workers: the SENDER computes `next = reducer(state, msg)` locally
// and commits it by CAS-creating v{n+1}. A lost CAS re-reads and recomputes.
//
// Why it is rejected as the general primitive:
//  * The transition runs at the sender — there is no place for durable side
//    effects (ctx.run/rpc), so this cannot host actor behavior, only pure
//    state folds. Effects would execute BEFORE the CAS decides whether the
//    transition is real → duplicated / phantom effects under contention.
//  * Every sender must ship the reducer code (no server-routed execution).
//  * Contention burns sender CPU on recompute-and-retry instead of queueing.
//
// What it is good for: low-contention pure registers/counters/CRDT-ish state
// where a full object runtime is overkill. It shares the chain runtime's
// storage shape, so promoting a CAS object to a chain object is an id-layout
// migration, not a rewrite.

import { Codec } from "../codec.js";
import type { Network } from "../network/network.js";
import { randomUUID } from "../platform.js";
import * as util from "../util.js";
import { createPromise, getPromise, probeHead } from "./wire.js";

export interface ReducerDef<S> {
  name: string;
  initial: (key: string) => S;
  /** Pure state folds — MUST be side-effect free (they may re-run on CAS loss). */
  reducers: Record<string, (state: S, ...args: any[]) => S>;
}

export class CasObjects {
  private network: Network;
  private codec: Codec;
  private ns: string;
  private watermarks = new Map<string, number>();

  constructor({ network, codec, namespace = "oc" }: { network: Network; codec?: Codec; namespace?: string }) {
    this.network = network;
    this.codec = codec ?? new Codec();
    this.ns = namespace;
  }

  get<S>(def: ReducerDef<S>, key: string): { apply(method: string, ...args: any[]): Promise<S>; read(): Promise<S> } {
    const base = `${this.ns}/${def.name}/${key}`;
    const idOf = (n: number) => `${base}/v${n}`;
    const send = this.network.send;

    const readAt = async (n: number): Promise<S> => {
      if (n === 0) return def.initial(key);
      const rec = await getPromise(send, this.codec, idOf(n - 1));
      return (rec?.param?.data as { s: S }).s;
    };

    return {
      apply: async (method: string, ...args: any[]): Promise<S> => {
        const reducer = def.reducers[method];
        if (!reducer) throw new Error(`no reducer '${method}' on '${def.name}'`);
        const ik = randomUUID();
        let n = await probeHead(send, this.codec, idOf, this.watermarks.get(base) ?? 0);
        while (true) {
          const prev = await readAt(n);
          const next = reducer(structuredClone(prev), ...args);
          const rec = await createPromise(send, this.codec, {
            id: idOf(n),
            timeoutAt: Date.now() + 365 * 24 * util.HOUR,
            data: { s: next, ik },
            tags: { "resonate:scope": "global" },
          });
          if ((rec.param?.data as { ik?: string })?.ik === ik) {
            this.watermarks.set(base, n + 1);
            return next;
          }
          n++; // lost the CAS — recompute on top of the winner
        }
      },
      read: async (): Promise<S> => {
        const n = await probeHead(send, this.codec, idOf, this.watermarks.get(base) ?? 0);
        return readAt(n);
      },
    };
  }
}
