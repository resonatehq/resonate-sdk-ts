// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// Variant B — the GENERATION-LOOP object (Temporal entity-workflow style).
// The object is a chain of GENERATIONS; each generation is one long-running
// workflow that pre-creates a bounded mailbox of latent promises, processes
// deposits until the mailbox is exhausted (roll) or the object goes idle
// (passivate), and settles with the state snapshot the next generation
// hydrates from:
//
//   o/{T}/{k}/g0 ── mailbox g0.0 … g0.(N-1) ──▶ value {s}
//   o/{T}/{k}/g1 ── mailbox g1.0 … g1.(N-1) ──▶ value {s}      (rolled)
//   (idle: no pending generation at all — reactivated by the next sender)
//
// * Mailbox slots are the generation's FIRST N durable ops (ctx.promise), so
//   their ids are deterministic (`{gen}.0` … `{gen}.N-1`) and senders can
//   compute them. Senders DEPOSIT by racing to SETTLE a slot (settle is
//   first-writer-wins CAS); the loop awaits each slot in order.
// * Replay of a generation is bounded by the mailbox size N — the loop's
//   continue-as-new equivalent, except rolling is structural (the mailbox is
//   full) rather than a history-size heuristic.
// * Passivation mirrors Temporal's signal-drain choreography — and inherits
//   its subtlety: the loop must CLOSE unfilled slots (so senders move on),
//   then re-read them and process any deposit that beat the close. This
//   protocol is the price of a pull-style mailbox; the chain variant has no
//   equivalent because it has no loop to shut down.
//
// Compare chain.ts (per-message tasks, no activation/passivation protocol)
// and serial.ts (server-side serialization).

import type { Context, DurablePromise, Info } from "../async/context.js";
import { DurablePromise as DP } from "../async/context.js";
import type { Resonate } from "../async/resonate.js";
import { Codec } from "../codec.js";
import type { Network } from "../network/network.js";
import { Options } from "../options.js";
import { delay, randomUUID } from "../platform.js";
import * as util from "../util.js";
import { attach } from "./attach.js";
import {
  type CtxObjectHandle,
  type Envelope,
  errInfo,
  ObjectCallError,
  type ObjectContext,
  type ObjectDef,
  ObjectDeletedError,
  type ObjectHandle,
  SelfCallDeadlockError,
  type SlotResult,
} from "./types.js";
import { createPromise, getPromise, probeHead, settlePromise } from "./wire.js";

interface Reply {
  r?: any;
  e?: { name: string; message: string };
}

interface GenArgs {
  o: string;
  k: string;
  g: number;
}

const DEFAULT_MAILBOX = 8;
const DEFAULT_IDLE = 5 * util.SEC;
const DEFAULT_GEN_TIMEOUT = 24 * util.HOUR;
const DEPOSIT_RETRY_DELAY = 25;

export class LoopObjects {
  private resonate: Resonate;
  private network: Network;
  private codec: Codec;
  private ns: string;
  private pid: string;
  private defs = new Map<string, ObjectDef<any>>();
  private genWatermarks = new Map<string, number>();
  private loopName: string;

  constructor({
    resonate,
    network,
    codec,
    namespace = "ol",
    pid = randomUUID().replace(/-/g, ""),
  }: {
    resonate: Resonate;
    network: Network;
    codec?: Codec;
    namespace?: string;
    pid?: string;
  }) {
    this.resonate = resonate;
    this.network = network;
    this.codec = codec ?? new Codec();
    this.ns = namespace;
    this.pid = pid;
    this.loopName = `${namespace}.loop.dispatch`;
    this.resonate.register(this.loopName, this.loop);
  }

  register<S>(def: ObjectDef<S>): void {
    this.defs.set(def.name, def);
  }

  private baseId(type: string, key: string): string {
    return `${this.ns}/${type}/${key}`;
  }

  private genId(base: string, g: number): string {
    return `${base}/g${g}`;
  }

  /** Mailbox slot j of a generation: the generation's j-th durable op. */
  private mbId(gen: string, j: number): string {
    return `${gen}.${j}`;
  }

  // -- the generation workflow ---------------------------------------------

  private loop = async (ctx: Context, ga: GenArgs): Promise<SlotResult> => {
    const def = this.defs.get(ga.o);
    if (!def) throw new Error(`object type '${ga.o}' is not registered on this worker`);
    const base = this.baseId(ga.o, ga.k);
    const N = def.options?.mailbox ?? DEFAULT_MAILBOX;
    const idle = def.options?.idle ?? DEFAULT_IDLE;

    // The mailbox MUST be the generation's first N durable ops — engine op
    // ids are positional (`${gen}.0 … ${gen}.N-1`) and senders compute them.
    // Anything durable before this block (hydration!) would shift every slot
    // id and orphan all deposits, so the mailbox is created before the state
    // is even known.
    const slots: DurablePromise<Envelope>[] = [];
    for (let j = 0; j < N; j++) {
      slots.push(ctx.promise<Envelope>({ timeout: DEFAULT_GEN_TIMEOUT }));
    }

    // Hydrate from the newest non-poisoned predecessor generation.
    let state: any;
    let del = false;
    let hydrated = false;
    for (let i = ga.g - 1; i >= 0 && !hydrated; i--) {
      try {
        const v = await attach<SlotResult>(ctx, this.genId(base, i));
        state = v.s;
        del = !!v.del;
        hydrated = true;
      } catch {
        // poisoned generation — skip
      }
    }
    if (!hydrated) state = def.initial(ga.k);

    // Track idle timers so the generation can retire them: the engine's
    // structured concurrency will not fulfill a pass while ANY spawned op is
    // still pending, so a race-loser sleep would hold the generation open
    // until its timer fires. Settling them early (idempotent) lets the roll /
    // passivation commit immediately — at the cost of one cheap in-memory
    // replay pass (their "suspended" outcomes from this pass resolve on the
    // redirect).
    const sleeps: DurablePromise<undefined>[] = [];
    const retireSleeps = async (): Promise<void> => {
      const ids = sleeps.map((s) => s.id);
      const send = this.network.send;
      const codec = this.codec;
      await ctx.run(async (_: Info) => {
        for (const id of ids) await settlePromise(send, codec, id, "resolved", undefined);
      });
    };

    const handleEnvelope = async (env: Envelope): Promise<void> => {
      let reply: Reply;
      if (del) {
        reply = { e: errInfo(new ObjectDeletedError(ga.o, ga.k)) };
      } else if (env.m === "$delete") {
        del = true;
        reply = { r: undefined };
      } else if (!def.handlers[env.m]) {
        reply = { e: { name: "UnknownMethodError", message: `no handler '${env.m}' on '${ga.o}'` } };
      } else {
        const box = { state: structuredClone(state) };
        const octx = this.handlerCtx(ctx, ga, box);
        try {
          const r = await def.handlers[env.m](octx, ...env.a);
          state = box.state;
          reply = { r };
        } catch (err) {
          reply = { e: errInfo(err) };
        }
      }
      if (env.r) {
        const replyId = env.r;
        const send = this.network.send;
        const codec = this.codec;
        await ctx.run(async (_: Info) => {
          await settlePromise(send, codec, replyId, "resolved", reply);
        });
      }
    };

    // Close slots j.. so senders stop depositing here, then re-read each and
    // process deposits that BEAT the close (the Temporal signal-drain move).
    const closeAndDrain = async (from: number): Promise<void> => {
      const send = this.network.send;
      const codec = this.codec;
      for (let j = from; j < N; j++) {
        const slotId = this.mbId(ctx.id, j);
        const winner = await ctx.run(async (_: Info) => {
          const rec = await settlePromise(send, codec, slotId, "resolved", {
            closed: true,
          } satisfies Partial<Envelope>);
          return rec?.value?.data as Envelope | undefined;
        });
        if (winner && !winner.closed) {
          await handleEnvelope(winner as Envelope);
        }
      }
    };

    for (let j = 0; j < N; j++) {
      const idleTimer = ctx.sleep(idle) as DurablePromise<undefined>;
      sleeps.push(idleTimer);
      const winner = await Promise.race([slots[j], idleTimer]);
      if (winner === undefined) {
        // Idle — passivate. After this returns, the object has NO pending
        // promise, NO task, NO worker memory: it exists only as settled
        // records until a sender reactivates it.
        await closeAndDrain(j);
        await retireSleeps();
        return { s: state, del: del || undefined };
      }
      if (winner.closed) {
        // A previous incomplete passivation (crash mid-close) — finish it.
        await closeAndDrain(j + 1);
        await retireSleeps();
        return { s: state, del: del || undefined };
      }
      await handleEnvelope(winner);
    }
    await retireSleeps();

    // Mailbox exhausted — roll to the next generation (continue-as-new).
    // The successor hydrates by awaiting THIS generation's promise, which
    // settles when we return below — serialization across the roll is free.
    // `detached` re-roots the successor: its replay scope starts fresh.
    await ctx.detached(
      this.loopName,
      { o: ga.o, k: ga.k, g: ga.g + 1 } satisfies GenArgs,
      new Options({ id: this.genId(base, ga.g + 1), timeout: DEFAULT_GEN_TIMEOUT, target: this.network.anycast }),
    );
    return { s: state, del: del || undefined };
  };

  // -- sender protocol ------------------------------------------------------

  /**
   * Find the active generation (creating it if the object is passivated) and
   * deposit the envelope into the lowest free mailbox slot. At-least-once
   * with adoption: a retry re-finds its own deposit by ik within the current
   * generation before depositing again.
   */
  private async deposit(def: ObjectDef<any>, env: Envelope): Promise<string> {
    const base = this.baseId(env.o, env.k);
    const N = def.options?.mailbox ?? DEFAULT_MAILBOX;
    const send = this.network.send;

    let g = await probeHead(send, this.codec, (n) => this.genId(base, n), this.genWatermarks.get(base) ?? 0);
    // probeHead returns the first MISSING generation; the candidate is its
    // predecessor if that one is still pending, else the missing one itself.
    if (g > 0) g--;

    while (true) {
      const genId = this.genId(base, g);
      const gen = await getPromise(send, this.codec, genId);

      if (!gen) {
        // Passivated (or never activated) — activate generation g: a plain
        // promise.create with a target makes the server mint a pending task
        // and dispatch it to the object worker group. Idempotent CAS: losing
        // to a concurrent activator returns the existing record, no dup task.
        await createPromise(send, this.codec, {
          id: genId,
          timeoutAt: Date.now() + DEFAULT_GEN_TIMEOUT,
          data: { func: this.loopName, args: [{ o: env.o, k: env.k, g } satisfies GenArgs], version: 1 },
          tags: {
            "resonate:target": this.network.anycast,
            "resonate:scope": "global",
            "resonate:origin": genId,
            "resonate:prefix": genId,
            "resonate:branch": genId,
            "resonate:parent": genId,
            "resonate:object": `${env.o}/${env.k}`,
          },
        });
        this.genWatermarks.set(base, g);
        continue; // re-read, then deposit into it
      }

      if (gen.state !== "pending") {
        g++;
        continue;
      }

      // Adoption scan: our ik may already occupy a slot of this generation.
      for (let j = 0; j < N; j++) {
        const rec = await getPromise(send, this.codec, this.mbId(genId, j));
        const prior = rec?.value?.data as Envelope | undefined;
        if (rec?.state === "resolved" && prior?.ik === env.ik) return this.mbId(genId, j);
      }

      // Deposit: race to settle the lowest free slot.
      for (let j = 0; j < N; ) {
        const slotId = this.mbId(genId, j);
        const rec = await settlePromise(send, this.codec, slotId, "resolved", env);
        if (!rec) {
          // Slot not created yet — the loop is still starting up. Wait briefly.
          await delay(DEPOSIT_RETRY_DELAY);
          continue;
        }
        const winner = rec.value?.data as Envelope | undefined;
        if (winner?.ik === env.ik) {
          return slotId;
        }
        if (winner?.closed) {
          // Generation is closing — move to the next.
          break;
        }
        j++;
      }
      g++;
    }
  }

  // -- client-side handle ---------------------------------------------------

  get<S>(def: ObjectDef<S>, key: string): ObjectHandle<S> {
    this.defs.set(def.name, def);
    const base = this.baseId(def.name, key);
    const send = this.network.send;

    const call = async (method: string, ...args: any[]): Promise<any> => {
      const replyId = `${base}/r/${randomUUID()}`;
      await createPromise(send, this.codec, {
        id: replyId,
        timeoutAt: Date.now() + DEFAULT_GEN_TIMEOUT,
        data: undefined,
        tags: { "resonate:scope": "global" },
      });
      await this.deposit(def, { o: def.name, k: key, m: method, a: args, ik: randomUUID(), r: replyId });
      const handle = await this.resonate.get(replyId);
      const reply = (await handle.result()) as Reply;
      if (reply.e) throw new ObjectCallError(reply.e, def.name, key, method);
      return reply.r;
    };

    return {
      type: def.name,
      key,
      call,
      send: async (method: string, ...args: any[]) =>
        this.deposit(def, { o: def.name, k: key, m: method, a: args, ik: randomUUID() }),
      read: () => this.readState(def, key),
      delete: async () => {
        await call("$delete");
      },
    };
  }

  /**
   * Snapshot read from the latest SETTLED generation. NOTE the loop variant's
   * structural weakness: state changes inside the ACTIVE generation are not
   * yet readable (they become durable at roll/passivation) — staleness is
   * bounded by the mailbox size, vs. one message in the chain variant.
   */
  private async readState<S>(
    def: ObjectDef<S>,
    key: string,
  ): Promise<{ state: S | undefined; deleted: boolean; seq: number }> {
    const base = this.baseId(def.name, key);
    const send = this.network.send;
    const head = await probeHead(send, this.codec, (n) => this.genId(base, n), this.genWatermarks.get(base) ?? 0);
    for (let i = head - 1; i >= 0; i--) {
      const rec = await getPromise(send, this.codec, this.genId(base, i));
      if (rec?.state === "resolved") {
        const v = rec.value?.data as SlotResult<S>;
        return { state: v.del ? undefined : v.s, deleted: !!v.del, seq: head };
      }
    }
    return { state: def.initial(key), deleted: false, seq: head };
  }

  // -- workflow-side handle -------------------------------------------------

  in(ctx: Context): { get<S>(def: ObjectDef<S>, key: string): CtxObjectHandle<S> } {
    return { get: <S>(def: ObjectDef<S>, key: string) => this.inCtx<S>(ctx, def, key) };
  }

  private inCtx<S>(
    ctx: Context,
    def: ObjectDef<S>,
    key: string,
    self?: { type: string; key: string },
  ): CtxObjectHandle<S> {
    this.defs.set(def.name, def);

    const depositOp = (env: Omit<Envelope, "ik">): DurablePromise<string> =>
      ctx.run(async (info: Info) => this.deposit(def, { ...env, ik: info.id }));

    return {
      type: def.name,
      key,
      call: <T = any>(method: string, ...args: any[]): DurablePromise<T> => {
        if (self && self.type === def.name && self.key === key) {
          throw new SelfCallDeadlockError(def.name, key, method);
        }
        const reply = ctx.promise<Reply>({ timeout: DEFAULT_GEN_TIMEOUT });
        const sent = depositOp({ o: def.name, k: key, m: method, a: args, r: reply.id });
        const facing = (async () => {
          await sent;
          const v = await reply;
          if (v.e) throw new ObjectCallError(v.e, def.name, key, method);
          return v.r as T;
        })();
        facing.catch(() => {});
        return new DP<T>(reply.id, facing);
      },
      send: (method: string, ...args: any[]): DurablePromise<string> =>
        depositOp({ o: def.name, k: key, m: method, a: args }),
      read: (): DurablePromise<{ state: S | undefined; deleted: boolean; seq: number }> =>
        ctx.run(async (_: Info) => this.readState(def, key)),
    };
  }

  private handlerCtx(ctx: Context, ga: GenArgs, box: { state: any }): ObjectContext<any> {
    return {
      type: ga.o,
      key: ga.k,
      seq: ga.g,
      id: ctx.id,
      get state() {
        return box.state;
      },
      set state(s: any) {
        box.state = s;
      },
      run: ctx.run.bind(ctx),
      rpc: ctx.rpc.bind(ctx),
      sleep: ctx.sleep.bind(ctx),
      promise: ctx.promise.bind(ctx),
      detached: ctx.detached.bind(ctx),
      options: ctx.options.bind(ctx),
      getDependency: ctx.getDependency.bind(ctx),
      object: <T>(odef: ObjectDef<T>, okey: string) => this.inCtx<T>(ctx, odef, okey, { type: ga.o, key: ga.k }),
    };
  }
}
