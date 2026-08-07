// EXPERIMENTAL — Resonate Durable Objects prototypes.
//
// Shared vocabulary for the durable-object prototypes in this directory. An
// object definition is runtime-agnostic: the same `defineObject(...)` value can
// be mounted on any of the prototype runtimes (chain, loop, serial) so the
// alternatives can be compared on identical user code.
//
// See README.md in this directory and the design document in the
// resonate-specification repo (design/durable-objects.md) for the full story.

import type { Context, DurablePromise } from "../async/context.js";

/**
 * The context a durable-object handler runs under. It is a durable-workflow
 * context (every `run`/`rpc`/`sleep`/`promise` is a durable operation of the
 * message's own computation — replay is bounded to ONE message) plus:
 *
 * - `state`: the object's materialized state, hydrated from the previous
 *   message's snapshot. Mutations to `state` are speculative during the
 *   handler and become durable atomically when the message settles. A handler
 *   that throws settles the message with the PRE-message state (rollback).
 * - `object(...)`: handles to other durable objects (object → object).
 */
export interface ObjectContext<S> {
  /** Object type name (the ObjectDef name). */
  readonly type: string;
  /** Object key — `(type, key)` is the object's identity. */
  readonly key: string;
  /** Sequence number of the message being handled (0-based). */
  readonly seq: number;
  /** Durable promise id of the message being handled. */
  readonly id: string;

  /** Materialized object state. Mutate freely; committed on settle. */
  state: S;

  // Durable operations — delegate to the underlying workflow context. Ids are
  // minted under the message's promise id, so replay scope = this message.
  run: Context["run"];
  rpc: Context["rpc"];
  sleep: Context["sleep"];
  promise: Context["promise"];
  detached: Context["detached"];
  options: Context["options"];
  getDependency: Context["getDependency"];

  /** Handle to another durable object (or this one, for self-sends). */
  object<T>(def: ObjectDef<T>, key: string): CtxObjectHandle<T>;
}

export type ObjectHandler<S> = (ctx: ObjectContext<S>, ...args: any[]) => Promise<any>;

export interface ObjectDef<S> {
  /** Type name; `(name, key)` addresses an object. */
  name: string;
  /** Initial state, materialized lazily on the object's first message. */
  initial: (key: string) => S;
  /** Message handlers. The handler's return value is the caller's result. */
  handlers: Record<string, ObjectHandler<S>>;
  options?: {
    /** Per-message timeout (ms) — bounds one message's processing. */
    messageTimeout?: number;
    /** loop runtime only: mailbox slots per generation (replay bound). */
    mailbox?: number;
    /** loop runtime only: idle time (ms) before the object passivates. */
    idle?: number;
  };
}

export function defineObject<S>(def: ObjectDef<S>): ObjectDef<S> {
  if (!def.name) throw new Error("object definition requires a name");
  for (const reserved of ["$delete"]) {
    if (reserved in def.handlers) throw new Error(`handler name '${reserved}' is reserved`);
  }
  return def;
}

/** Client-side handle (used outside any workflow). */
export interface ObjectHandle<S> {
  readonly type: string;
  readonly key: string;
  /** Enqueue a message and await its result (request/response). */
  call<T = any>(method: string, ...args: any[]): Promise<T>;
  /** Enqueue a message, do not await the result (one-way). Returns the message's durable promise id. */
  send(method: string, ...args: any[]): Promise<string>;
  /** Snapshot read of the object's state — no serialization, no handler. */
  read(): Promise<{ state: S | undefined; deleted: boolean; seq: number }>;
  /** Tombstone the object: subsequent messages fail, state is retired. */
  delete(): Promise<void>;
}

/** Workflow-side handle (used inside a durable function or another object). */
export interface CtxObjectHandle<S> {
  readonly type: string;
  readonly key: string;
  /** Durable call: enqueue + suspend until the object answers. */
  call<T = any>(method: string, ...args: any[]): DurablePromise<T>;
  /** Durable one-way send: enqueue exactly once, never await the result. */
  send(method: string, ...args: any[]): DurablePromise<string>;
  /** Durable snapshot read (wrapped as a durable operation of the caller). */
  read(): DurablePromise<{ state: S | undefined; deleted: boolean; seq: number }>;
  /**
   * Durable delayed one-way send (an alarm): fires `delayMs` from now without
   * occupying a mailbox position until it does. Self-targeting is the alarm
   * idiom (`ctx.object(def, ctx.key).sendLater(...)`). Chain runtime only for
   * now; loop/serial would add the same alarm indirection.
   */
  sendLater?(method: string, args: any[], delayMs: number): DurablePromise<string>;
}

// ---------------------------------------------------------------------------
// Wire envelopes
// ---------------------------------------------------------------------------

/** Message envelope — the param of a message promise. */
export interface Envelope {
  /** Object type. */
  o: string;
  /** Object key. */
  k: string;
  /** Sequence number (chain runtime; loop derives it from the slot id). */
  n?: number;
  /** Method name. */
  m: string;
  /** Arguments. */
  a: any[];
  /** Idempotency key — identifies the logical send across retries. */
  ik: string;
  /** Reply-to promise id (loop runtime; chain answers on the message itself). */
  r?: string;
  /** Loop runtime: a slot settled with `closed` carries no message — the
   * generation rolled or passivated and the sender must move on. */
  closed?: boolean;
}

/** Result envelope — the value a message promise settles with. */
export interface SlotResult<S = any> {
  /** State snapshot AFTER this message (pre-message state if the handler threw). */
  s: S;
  /** Handler return value (caller-visible result). */
  r?: any;
  /** Handler error (caller-visible failure); state was rolled back. */
  e?: { name: string; message: string };
  /** Tombstone: the object is deleted as of this message. */
  del?: boolean;
}

export class ObjectDeletedError extends Error {
  constructor(type: string, key: string) {
    super(`durable object ${type}/${key} is deleted`);
    this.name = "ObjectDeletedError";
  }
}

export class ObjectCallError extends Error {
  constructor(
    public readonly info: { name: string; message: string },
    type: string,
    key: string,
    method: string,
  ) {
    super(`durable object ${type}/${key}.${method} failed: ${info.message}`);
    this.name = "ObjectCallError";
  }
}

export class SelfCallDeadlockError extends Error {
  constructor(type: string, key: string, method: string) {
    super(
      `durable object ${type}/${key} called ${method} on itself and awaited the result — ` +
        `a serialized object awaiting its own mailbox can never make progress (use send instead)`,
    );
    this.name = "SelfCallDeadlockError";
  }
}

export function errInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}
