// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// Variant C — the SERIAL-DISPATCH object: what durable objects look like WITH
// the protocol extension the design document proposes. Two server-side rules,
// keyed by a single new tag:
//
//   resonate:serial = <key>
//
//   (S1) SERIALIZED DISPATCH — among all tasks whose promise carries the same
//        serial key, the server keeps at most one outside a terminal state
//        "released for execution" at a time, in promise-creation order. The
//        rest wait in the server, undispatched.
//   (S2) CHAIN STAMP — at create time the server stamps the promise with
//        `resonate:serial-prev = <id of the previous promise in the chain>`,
//        giving each invocation a durable pointer to its predecessor (and
//        thereby to the state snapshot in the predecessor's value).
//
// With S1+S2, a durable object is NOTHING BUT an ordinary durable function
// invocation: `ctx.rpc(handler, args, { tags: { "resonate:serial": key } })`.
// No head probing, no CAS retries, no mailbox choreography — compare the
// sender-side code here with chain.ts and loop.ts. This is the Restate
// virtual-object model expressed as one tag on the existing task machinery.
//
// `SerialDispatchNetwork` below emulates S1+S2 *outside* the server as a
// network middleware, exactly where the real implementation would sit inside
// it: it stamps creates on the way in and gates execute-message delivery on
// the way out (predecessor settled ⇒ release next). The runtime code above it
// would not change if the server took over.

import type { Context, DurablePromise, Info } from "../async/context.js";
import { DurablePromise as DP } from "../async/context.js";
import type { Resonate } from "../async/resonate.js";
import { Codec } from "../codec.js";
import type { Network } from "../network/network.js";
import type { Message, Request, Response } from "../network/types.js";
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
import { createPromise, getPromise, safeSegment, settlePromise } from "./wire.js";

/** Reply envelope — the value of a caller-created reply promise. */
interface Reply {
  r?: any;
  e?: { name: string; message: string };
}

// ---------------------------------------------------------------------------
// The protocol-extension emulation
// ---------------------------------------------------------------------------

interface Chain {
  /** Last promise id appended to this serial key (S2 stamp source). */
  last?: string;
  /** Creation-ordered ids waiting for their turn. */
  queue: string[];
  /** The id currently released for execution, if any. */
  inflight?: string;
}

export class SerialDispatchNetwork implements Network {
  private chains = new Map<string, Chain>();
  /** promise id → serial key, for settle detection. */
  private serialOf = new Map<string, string>();
  /** Held execute messages awaiting their turn (latest per task id). */
  private held = new Map<string, Message>();
  private subs: Array<(msg: Message) => void> = [];
  private wired = false;
  private pollId?: ReturnType<typeof setInterval>;

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

  async init(): Promise<void> {
    await this.inner.init();
    // Safety net: an inflight promise can settle without any client request
    // (server-side timeout). Poll it so the chain cannot wedge.
    this.pollId = setInterval(() => this.pollInflight(), 250);
  }

  async stop(): Promise<void> {
    if (this.pollId) clearInterval(this.pollId);
    await this.inner.stop();
  }

  send = (<K extends Request["kind"]>(req: Extract<Request, { kind: K }>): Promise<Extract<Response, { kind: K }>> => {
    const r = req as Request;

    // (S2) Stamp serialized creates with their predecessor, synchronously,
    // before the request leaves — creation order defines the chain.
    const createData =
      r.kind === "promise.create"
        ? r.data
        : r.kind === "task.create"
          ? r.data.action.data
          : r.kind === "task.fence" && r.data.action.kind === "promise.create"
            ? r.data.action.data
            : undefined;
    const skey = createData?.tags?.["resonate:serial"];
    if (createData && skey) {
      const chain = this.chain(skey);
      createData.tags["resonate:serial-prev"] = chain.last ?? "";
      chain.last = createData.id;
      chain.queue.push(createData.id);
      this.serialOf.set(createData.id, skey);
      return this.inner.send(req).then((res) => {
        this.pump(skey);
        return res;
      });
    }

    // Settlement of a serialized promise frees its chain.
    const settledId =
      r.kind === "promise.settle"
        ? r.data.id
        : r.kind === "task.fulfill"
          ? r.data.action.data.id
          : r.kind === "task.fence" && r.data.action.kind === "promise.settle"
            ? r.data.action.data.id
            : undefined;
    if (settledId && this.serialOf.has(settledId)) {
      return this.inner.send(req).then((res) => {
        this.onSettled(settledId);
        return res;
      });
    }

    return this.inner.send(req);
  }) as Network["send"];

  recv(cb: (msg: Message) => void): void {
    this.subs.push(cb);
    if (!this.wired) {
      this.wired = true;
      this.inner.recv((msg) => this.route(msg));
    }
  }

  // (S1) Gate the dispatch edge: hold execute messages for serialized tasks
  // that are not at the head of their chain.
  private route(msg: Message): void {
    if (msg.kind === "execute") {
      const id = msg.data.task.id;
      const skey = this.serialOf.get(id);
      if (skey) {
        const chain = this.chain(skey);
        if (chain.inflight !== id) {
          this.held.set(id, msg);
          this.pump(skey);
          return;
        }
      }
    }
    for (const cb of this.subs) cb(msg);
  }

  private chain(skey: string): Chain {
    let c = this.chains.get(skey);
    if (!c) {
      c = { queue: [] };
      this.chains.set(skey, c);
    }
    return c;
  }

  private pump(skey: string): void {
    const chain = this.chain(skey);
    if (chain.inflight || chain.queue.length === 0) return;
    chain.inflight = chain.queue[0];
    const held = this.held.get(chain.inflight);
    if (held) {
      this.held.delete(chain.inflight);
      for (const cb of this.subs) cb(held);
    }
    // If the execute message has not arrived yet it will pass through route()
    // unimpeded once it does, because inflight now names it.
  }

  private onSettled(id: string): void {
    const skey = this.serialOf.get(id);
    if (!skey) return;
    const chain = this.chain(skey);
    const idx = chain.queue.indexOf(id);
    if (idx >= 0) chain.queue.splice(idx, 1);
    this.held.delete(id);
    if (chain.inflight === id) {
      chain.inflight = undefined;
      this.pump(skey);
    }
  }

  private pollInflight(): void {
    for (const chain of this.chains.values()) {
      const id = chain.inflight;
      if (!id) continue;
      this.inner
        .send({ kind: "promise.get", head: { corrId: randomUUID(), version: util.VERSION }, data: { id } })
        .then((res) => {
          if (res.head.status === 200 && typeof res.data !== "string" && res.data.promise.state !== "pending") {
            this.onSettled(id);
          }
        })
        .catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// The runtime on top of the extension
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 24 * util.HOUR;

export class SerialObjects {
  private resonate: Resonate;
  private network: Network;
  private codec: Codec;
  private ns: string;
  private defs = new Map<string, ObjectDef<any>>();
  private dispatchName: string;

  constructor({
    resonate,
    network,
    codec,
    namespace = "os",
  }: {
    resonate: Resonate;
    /** Must be (or wrap) the SerialDispatchNetwork the Resonate instance uses. */
    network: Network;
    codec?: Codec;
    namespace?: string;
  }) {
    this.resonate = resonate;
    this.network = network;
    this.codec = codec ?? new Codec();
    this.ns = namespace;
    this.dispatchName = `${namespace}.serial.dispatch`;
    this.resonate.register(this.dispatchName, this.dispatch);
  }

  register<S>(def: ObjectDef<S>): void {
    this.defs.set(def.name, def);
  }

  private baseId(type: string, key: string): string {
    return `${this.ns}/${type}/${key}`;
  }

  // -- the invocation executor ---------------------------------------------

  /**
   * Executes ONE serialized invocation. By the time this runs, the extension
   * guarantees every earlier invocation of the same serial key has settled;
   * the predecessor pointer (S2) leads to the latest state snapshot. Replay
   * scope: this invocation only.
   */
  private dispatch = async (ctx: Context, env: Envelope): Promise<SlotResult> => {
    const def = this.defs.get(env.o);
    if (!def) throw new Error(`object type '${env.o}' is not registered on this worker`);
    const send = this.network.send;
    const codec = this.codec;
    const selfId = ctx.id;

    // Read our own record for the server-stamped predecessor pointer.
    let prevId = await ctx.run(async (_: Info) => {
      const rec = await getPromise(send, codec, selfId);
      return rec?.tags?.["resonate:serial-prev"] ?? "";
    });

    // Hydrate: follow predecessor pointers to the newest resolved snapshot.
    let state: any;
    let del = false;
    let hydrated = false;
    while (prevId && !hydrated) {
      try {
        const v = await attach<SlotResult>(ctx, prevId);
        state = v.s;
        del = !!v.del;
        hydrated = true;
      } catch {
        // poisoned predecessor — hop over it via ITS predecessor pointer
        const hop: string = prevId;
        prevId = await ctx.run(async (_: Info) => {
          const rec = await getPromise(send, codec, hop);
          return rec?.tags?.["resonate:serial-prev"] ?? "";
        });
      }
    }
    if (!hydrated) state = def.initial(env.k);

    let result: SlotResult;
    if (del) {
      result = { s: state, del: true, e: errInfo(new ObjectDeletedError(env.o, env.k)) };
    } else if (env.m === "$delete") {
      result = { s: state, del: true };
    } else if (env.m === "$read") {
      result = { s: state, r: { state, deleted: false } };
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

    // Workflow callers await a reply promise in THEIR origin (never this
    // invocation promise — cross-origin callbacks are refused); answer it
    // idempotently before committing.
    if (env.r) {
      const replyId = env.r;
      const reply: Reply = result.e ? { e: result.e } : { r: result.r };
      await ctx.run(async (_: Info) => {
        await settlePromise(send, codec, replyId, "resolved", reply);
      });
    }

    return result;
  };

  // -- client-side handle ---------------------------------------------------

  // Shared enqueue: one invocation promise under the object's ORIGIN
  // (`os/T/k:i-…` — the server partitions state and gates callbacks by
  // origin, so the whole chain must share one; see src/ids.ts). `suffix`
  // identifies the logical send: a uuid for one-shot clients, a
  // deterministic caller-derived segment for workflow senders (replays
  // adopt the same invocation via the idempotent create).
  private async enqueue(
    def: ObjectDef<any>,
    key: string,
    method: string,
    args: any[],
    suffix: string,
    replyTo?: string,
  ): Promise<string> {
    const base = this.baseId(def.name, key);
    const timeout = def.options?.messageTimeout ?? DEFAULT_TIMEOUT;
    const id = `${base}:i-${suffix}`;
    await createPromise(this.network.send, this.codec, {
      id,
      timeoutAt: Date.now() + timeout,
      data: {
        func: this.dispatchName,
        args: [{ o: def.name, k: key, m: method, a: args, ik: id, r: replyTo } satisfies Envelope],
        version: 1,
      },
      tags: {
        "resonate:target": this.network.anycast,
        "resonate:scope": "global",
        "resonate:serial": base,
        "resonate:origin": base,
        "resonate:branch": id,
        "resonate:parent": base,
      },
    });
    return id;
  }

  get<S>(def: ObjectDef<S>, key: string): ObjectHandle<S> {
    this.defs.set(def.name, def);

    const call = async (method: string, ...args: any[]): Promise<any> => {
      const id = await this.enqueue(def, key, method, args, randomUUID());
      const handle = await this.resonate.get(id);
      const out = (await handle.result()) as SlotResult;
      if (out.e) throw new ObjectCallError(out.e, def.name, key, method);
      return out.r;
    };

    return {
      type: def.name,
      key,
      call,
      send: (method: string, ...args: any[]) => this.enqueue(def, key, method, args, randomUUID()),
      // Reads are serialized invocations here — without a head pointer there
      // is nothing to probe (invocation ids are opaque). The design document
      // discusses the read-side extension (a per-serial-key head query) that
      // would restore chain.ts's concurrent snapshot reads.
      read: async () => {
        const r = await call("$read");
        return { state: r.state as S | undefined, deleted: !!r.deleted, seq: -1 };
      },
      delete: async () => {
        await call("$delete");
      },
    };
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
    const timeout = def.options?.messageTimeout ?? DEFAULT_TIMEOUT;

    // Durable enqueue: the leaf's own id (sanitized — it carries the reserved
    // separators) is the invocation-id suffix, so a replayed or retried pass
    // adopts the identical invocation instead of enqueueing twice. Under the
    // real extension (server-side S1+S2) this leaf collapses into a plain
    // tagged create; the leaf shape is the userland stand-in.
    const enqueueOp = (method: string, args: any[], replyTo?: string): DurablePromise<string> =>
      ctx.run(async (info: Info) => this.enqueue(def, key, method, args, safeSegment(info.id), replyTo));

    // Request/response rides a caller-owned reply promise (a latent child of
    // the CALLER, settled by the object): the caller only ever awaits its own
    // origin's promises, as the server's origin partitioning requires —
    // awaiting the invocation promise itself would be a cross-origin callback.
    const callVia = <T>(method: string, args: any[], unwrap: (v: Reply) => T): DurablePromise<T> => {
      const reply = ctx.promise<Reply>({ timeout });
      const sent = enqueueOp(method, args, reply.id);
      const facing = (async () => {
        await sent;
        return unwrap(await reply);
      })();
      facing.catch(() => {});
      return new DP<T>(reply.id, facing);
    };

    return {
      type: def.name,
      key,
      call: <T = any>(method: string, ...args: any[]): DurablePromise<T> => {
        if (self && self.type === def.name && self.key === key) {
          throw new SelfCallDeadlockError(def.name, key, method);
        }
        return callVia<T>(method, args, (v) => {
          if (v.e) throw new ObjectCallError(v.e, def.name, key, method);
          return v.r as T;
        });
      },
      // One-way send: the durable enqueue is the whole operation — the caller
      // never awaits the invocation, so it does not block completion.
      send: (method: string, ...args: any[]): DurablePromise<string> => enqueueOp(method, args),
      read: (): DurablePromise<{ state: S | undefined; deleted: boolean; seq: number }> =>
        callVia("$read", [], (v) => {
          const r = v.r as { state: S | undefined; deleted: boolean };
          return { state: r.state, deleted: r.deleted, seq: -1 };
        }),
    };
  }

  private handlerCtx(ctx: Context, env: Envelope, box: { state: any }): ObjectContext<any> {
    return {
      type: env.o,
      key: env.k,
      seq: -1,
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
