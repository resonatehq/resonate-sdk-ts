// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// Variant A — the MESSAGE-CHAIN object. No protocol extension; no long-lived
// loop. The object IS the totally-ordered chain of its message promises:
//
//   o/{Type}/{key}/m0  →  o/{Type}/{key}/m1  →  o/{Type}/{key}/m2  →  ...
//
// * Senders append to the chain with promise.create as CAS at the head (the
//   winner of slot n holds message n; the loser retries at n+1). The create
//   carries a `resonate:target`, so the server mints a task per message and
//   dispatches it to the object worker group — any worker, no affinity.
// * The worker executing message n first durably AWAITS message n-1's promise
//   (suspending on it if pending). That await is the serialization: handler n
//   cannot run its effects before message n-1 has settled. The server's
//   callback/resume machinery does the ordering; no lock exists anywhere.
// * Message n-1's promise VALUE carries the state snapshot after n-1. So
//   state is materialized at every step (Restate-style), the journal of a
//   message is the message's own durable children (replay bound = ONE
//   message), and an idle object occupies no worker memory, no pending task,
//   nothing but settled records (bounded-objects story: passivation is free
//   because there is no activation).
// * Replies travel on caller-created reply promises (the caller of `call`
//   makes a latent promise and the object resolves it), so one-way sends cost
//   exactly one promise.
//
// This file is deliberately verbose in comments: it is the reference
// prototype the design document walks through.

import type { Context, DurablePromise, Info } from "../async/context.js";
import { DurablePromise as DP } from "../async/context.js";
import type { Resonate } from "../async/resonate.js";
import { Codec } from "../codec.js";
import type { Network } from "../network/network.js";
import { randomUUID } from "../platform.js";
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

/** Reply envelope — the value of a caller-created reply promise. */
interface Reply {
  r?: any;
  e?: { name: string; message: string };
}

const DEFAULT_MESSAGE_TIMEOUT = 24 * util.HOUR;

export class ChainObjects {
  private resonate: Resonate;
  private network: Network;
  private codec: Codec;
  private ns: string;
  private defs = new Map<string, ObjectDef<any>>();
  /** Per-object head hints — pure optimization for the probe. */
  private watermarks = new Map<string, number>();
  private dispatchName: string;
  private alarmName: string;

  constructor({
    resonate,
    network,
    codec,
    namespace = "o",
  }: {
    resonate: Resonate;
    network: Network;
    codec?: Codec;
    namespace?: string;
  }) {
    this.resonate = resonate;
    this.network = network;
    this.codec = codec ?? new Codec();
    this.ns = namespace;
    this.dispatchName = `${namespace}.chain.dispatch`;
    this.alarmName = `${namespace}.chain.alarm`;
    this.resonate.register(this.dispatchName, this.dispatch);
    this.resonate.register(this.alarmName, this.alarm);
  }

  register<S>(def: ObjectDef<S>): void {
    this.defs.set(def.name, def);
  }

  // -- addressing -----------------------------------------------------------

  private baseId(type: string, key: string): string {
    return `${this.ns}/${type}/${key}`;
  }

  private slotId(base: string, n: number): string {
    return `${base}/m${n}`;
  }

  // -- append (the CAS at the head) ----------------------------------------

  /**
   * Append a message to the object's chain, exactly once per idempotency key.
   * Probes the head, then CAS-creates; on losing a slot to a concurrent
   * sender, retries at the next. A retry of a crashed sender re-finds its own
   * earlier append by ik and adopts it instead of appending twice.
   */
  private async append(env: Envelope, timeout: number): Promise<{ id: string; n: number }> {
    const base = this.baseId(env.o, env.k);
    const idOf = (n: number) => this.slotId(base, n);
    const send = this.network.send;

    let n = await probeHead(send, this.codec, idOf, this.watermarks.get(base) ?? 0);

    // Crash-retry adoption: our ik may already sit in a slot below the head.
    // Scan back a bounded window (a crashed sender's slot is near the head).
    for (let i = Math.max(0, n - ADOPT_WINDOW); i < n; i++) {
      const rec = await getPromise(send, this.codec, idOf(i));
      const prior = rec?.param?.data?.args?.[0] as Envelope | undefined;
      if (prior?.ik === env.ik) {
        this.watermarks.set(base, n);
        return { id: idOf(i), n: i };
      }
    }

    while (true) {
      const rec = await createPromise(send, this.codec, {
        id: idOf(n),
        timeoutAt: Date.now() + timeout,
        data: { func: this.dispatchName, args: [{ ...env, n }], version: 1 },
        tags: {
          "resonate:target": this.network.anycast,
          "resonate:scope": "global",
          "resonate:origin": idOf(n),
          "resonate:prefix": idOf(n),
          "resonate:branch": idOf(n),
          "resonate:parent": idOf(n),
          "resonate:object": `${env.o}/${env.k}`,
        },
      });
      const winner = rec.param?.data?.args?.[0] as Envelope | undefined;
      if (winner?.ik === env.ik) {
        this.watermarks.set(base, n + 1);
        return { id: idOf(n), n };
      }
      n++;
    }
  }

  // -- the message executor -------------------------------------------------

  /**
   * Registered workflow that executes ONE message. The server dispatched it
   * because the message promise carries a target; serialization comes from
   * the hydration await below, state from the predecessor's value.
   */
  private dispatch = async (ctx: Context, env: Envelope): Promise<SlotResult> => {
    const def = this.defs.get(env.o);
    if (!def) throw new Error(`object type '${env.o}' is not registered on this worker`);

    const n = env.n ?? 0;
    const base = this.baseId(env.o, env.k);

    // Hydrate: durably await the predecessor (THE serialization point), take
    // its value as the state snapshot. A rejected/timed-out predecessor is a
    // poison message: skip it and walk further back. Termination: message 0
    // falls through to initial().
    let state: any;
    let del = false;
    let hydrated = false;
    for (let i = n - 1; i >= 0 && !hydrated; i--) {
      try {
        const v = await attach<SlotResult>(ctx, this.slotId(base, i));
        state = v.s;
        del = !!v.del;
        hydrated = true;
      } catch {
        // poison predecessor — skip
      }
    }
    if (!hydrated) state = def.initial(env.k);

    // Run the handler against a draft; on error the draft is discarded and
    // the message settles with the PRE-message snapshot (state rollback, but
    // the chain still advances — a failed message does not wedge the object).
    let result: SlotResult;
    if (del) {
      result = { s: state, del: true, e: errInfo(new ObjectDeletedError(env.o, env.k)) };
    } else if (env.m === "$delete") {
      result = { s: state, del: true };
    } else if (!def.handlers[env.m]) {
      result = { s: state, e: { name: "UnknownMethodError", message: `no handler '${env.m}' on '${env.o}'` } };
    } else {
      const box = { state: structuredClone(state) };
      const octx = this.handlerCtx(ctx, env, box);
      try {
        const r = await def.handlers[env.m](octx, ...env.a);
        result = { s: box.state, r };
      } catch (err) {
        result = { s: state, e: errInfo(err) };
      }
    }

    // Answer the caller (idempotent settle — at-least-once safe), then commit
    // by returning: the engine settles the message promise with `result`,
    // which is the state snapshot the successor hydrates from.
    if (env.r) {
      const replyId = env.r;
      const reply: Reply = result.e ? { e: result.e } : { r: result.r };
      const send = this.network.send;
      const codec = this.codec;
      await ctx.run(async (_: Info) => {
        await settlePromise(send, codec, replyId, "resolved", reply);
      });
    }

    return result;
  };

  /** Registered workflow behind sendLater: fires at the delay, then appends. */
  private alarm = async (ctx: Context, env: Envelope, timeout: number): Promise<string> => {
    const id = await ctx.run(async (_: Info) => (await this.append(env, timeout)).id);
    return id as string;
  };

  // -- client-side handle (outside any workflow) ---------------------------

  get<S>(
    def: ObjectDef<S>,
    key: string,
  ): ObjectHandle<S> & { sendLater(method: string, args: any[], delayMs: number): Promise<string> } {
    this.defs.set(def.name, def);
    const timeout = def.options?.messageTimeout ?? DEFAULT_MESSAGE_TIMEOUT;
    const base = this.baseId(def.name, key);
    const send = this.network.send;

    const call = async (method: string, ...args: any[]): Promise<any> => {
      const replyId = `${base}/r/${randomUUID()}`;
      await createPromise(send, this.codec, {
        id: replyId,
        timeoutAt: Date.now() + timeout,
        data: undefined,
        tags: { "resonate:scope": "global" },
      });
      await this.append({ o: def.name, k: key, m: method, a: args, ik: randomUUID(), r: replyId }, timeout);
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
        (await this.append({ o: def.name, k: key, m: method, a: args, ik: randomUUID() }, timeout)).id,
      sendLater: async (method: string, args: any[], delayMs: number) => {
        const alarmId = `${base}/alarm/${randomUUID()}`;
        const env: Envelope = { o: def.name, k: key, m: method, a: args, ik: alarmId };
        await createPromise(send, this.codec, {
          id: alarmId,
          timeoutAt: Date.now() + delayMs + timeout,
          data: { func: this.alarmName, args: [env, timeout], version: 1 },
          tags: {
            "resonate:target": this.network.anycast,
            "resonate:scope": "global",
            "resonate:delay": String(Date.now() + delayMs),
          },
        });
        return alarmId;
      },
      read: () => this.readState(def, key),
      delete: async () => {
        await call("$delete");
      },
    };
  }

  /**
   * Snapshot read: walk back from the head to the latest RESOLVED message and
   * return its state snapshot. Concurrent, unserialized, worker-free — the
   * durable-object equivalent of Restate's shared handler / a DO storage read.
   */
  private async readState<S>(
    def: ObjectDef<S>,
    key: string,
  ): Promise<{ state: S | undefined; deleted: boolean; seq: number }> {
    const base = this.baseId(def.name, key);
    const idOf = (n: number) => this.slotId(base, n);
    const send = this.network.send;
    const head = await probeHead(send, this.codec, idOf, this.watermarks.get(base) ?? 0);
    for (let i = head - 1; i >= 0; i--) {
      const rec = await getPromise(send, this.codec, idOf(i));
      if (rec?.state === "resolved") {
        const v = rec.value?.data as SlotResult<S>;
        return { state: v.del ? undefined : v.s, deleted: !!v.del, seq: head };
      }
    }
    return { state: def.initial(key), deleted: false, seq: head };
  }

  // -- workflow-side handle (inside a durable function or another object) --

  in(ctx: Context): { get<S>(def: ObjectDef<S>, key: string): CtxObjectHandle<S> } {
    return {
      get: <S>(def: ObjectDef<S>, key: string) => this.inCtx<S>(ctx, def, key),
    };
  }

  private inCtx<S>(
    ctx: Context,
    def: ObjectDef<S>,
    key: string,
    self?: { type: string; key: string },
  ): CtxObjectHandle<S> {
    this.defs.set(def.name, def);
    const timeout = def.options?.messageTimeout ?? DEFAULT_MESSAGE_TIMEOUT;

    // Durable append: the leaf's own id is the idempotency key, so a replayed
    // or retried pass adopts the identical slot instead of appending twice.
    const appendOp = (env: Omit<Envelope, "ik">): DurablePromise<string> =>
      ctx.run(async (info: Info) => (await this.append({ ...env, ik: info.id }, timeout)).id);

    return {
      type: def.name,
      key,
      call: <T = any>(method: string, ...args: any[]): DurablePromise<T> => {
        if (self && self.type === def.name && self.key === key) {
          throw new SelfCallDeadlockError(def.name, key, method);
        }
        // Reply promise FIRST (sequenced synchronously — deterministic id),
        // then the append leaf. Both are durable ops of the caller; the
        // caller suspends on the reply like on any awaited promise.
        const reply = ctx.promise<Reply>({ timeout });
        const sent = appendOp({ o: def.name, k: key, m: method, a: args, r: reply.id });
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
        appendOp({ o: def.name, k: key, m: method, a: args }),
      read: (): DurablePromise<{ state: S | undefined; deleted: boolean; seq: number }> =>
        ctx.run(async (_: Info) => this.readState(def, key)),
      // Alarm from inside a handler/workflow: the leaf's own id makes the
      // alarm id deterministic, so replays and retries adopt the same alarm
      // instead of scheduling twice. The alarm promise is detached (own
      // lifetime, delayed dispatch) and appends to the mailbox on fire — it
      // must NOT hold a mailbox slot in the meantime, or it would block
      // every later message until it fires.
      sendLater: (method: string, args: any[], delayMs: number): DurablePromise<string> =>
        ctx.run(async (info: Info) => {
          const alarmId = `${this.baseId(def.name, key)}/alarm/${info.id}`;
          const env: Envelope = { o: def.name, k: key, m: method, a: args, ik: alarmId };
          await createPromise(this.network.send, this.codec, {
            id: alarmId,
            timeoutAt: Date.now() + delayMs + timeout,
            data: { func: this.alarmName, args: [env, timeout], version: 1 },
            tags: {
              "resonate:target": this.network.anycast,
              "resonate:scope": "global",
              "resonate:delay": String(Date.now() + delayMs),
            },
          });
          return alarmId;
        }),
    };
  }

  // -- handler context ------------------------------------------------------

  private handlerCtx(ctx: Context, env: Envelope, box: { state: any }): ObjectContext<any> {
    return {
      type: env.o,
      key: env.k,
      seq: env.n ?? 0,
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
      object: <T>(odef: ObjectDef<T>, okey: string) => this.inCtx<T>(ctx, odef, okey, { type: env.o, key: env.k }),
    };
  }
}

/** How far below the head a crashed sender's append is searched for by ik. */
const ADOPT_WINDOW = 8;
