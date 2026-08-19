// =============================================================================
// Connection protocols
// =============================================================================
//
// The Resonate SDK talks to a Resonate server over two independent channels,
// captured by two independent protocols:
//
// - `Network`: the request/response path (`send`). Requests go to the server,
//   a matching response comes back.
// - `Source`: the push-message path (`recv`) plus the addressing that makes
//   delivery possible (`unicast`/`anycast`/`match`). Identity (`pid`/`group`)
//   lives on `Source` because addresses embed it.
//
// `Network` and `Source` are the *only* things named network/source; every
// implementation is a **connection**. A connection may implement one or both
// protocols:
//
// - HTTP is request/response only        -> `Network`
// - SSE is push only                     -> `Source`
// - NATS, Postgres, and the in-process
//   local simulation are both            -> `Network` + `Source`
//
// A `Resonate` instance uses exactly one network and one or more sources.

import type { Message, Request, Response } from "./types.js";

/** Send a request to the server and await its matching response. */
export type Send = <K extends Request["kind"]>(
  req: Extract<Request, { kind: K }>,
) => Promise<Extract<Response, { kind: K }>>;

/** Register a callback for push messages (execute / unblock). */
export type Recv = (callback: (msg: Message) => void) => void;

/**
 * The request/response half of a connection: requests to the server.
 */
export interface Network {
  send: Send;

  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The push half of a connection: messages from the server, and the identity
 * and addressing that make delivery possible.
 */
export interface Source {
  /** This process's id; a callback/listener targets it (unicast). */
  readonly pid: string;
  /** This process's worker group; a task targets the group (anycast). */
  readonly group: string;

  /** Address that routes a message to this specific process. */
  readonly unicast: string;
  /** Address that routes a message to any member of this process's group. */
  readonly anycast: string;

  recv: Recv;

  /** Resolve a plain target string (e.g. "default") into a routable address. */
  match(target: string): string;

  start(): Promise<void>;
  stop(): Promise<void>;
}

// =============================================================================
// Runtime guards
// =============================================================================
//
// TypeScript checks these protocols structurally at compile time, but the
// `Resonate` constructor also guards at runtime so a plain-JS caller passing
// a partial object fails fast with a `TypeError` naming the missing members —
// instead of an `AttributeError`-style crash inside a fire-and-forget task.

const NETWORK_METHODS = ["send", "start", "stop"] as const;
const SOURCE_METHODS = ["recv", "match", "start", "stop"] as const;
const SOURCE_PROPS = ["pid", "group", "unicast", "anycast"] as const;

function missingMembers(x: unknown, methods: readonly string[], props: readonly string[] = []): string[] {
  if (typeof x !== "object" || x === null) return [...methods, ...props];
  const obj = x as Record<string, unknown>;
  const missing: string[] = [];
  for (const m of methods) {
    if (typeof obj[m] !== "function") missing.push(`${m}()`);
  }
  for (const p of props) {
    if (typeof obj[p] !== "string") missing.push(p);
  }
  return missing;
}

/** True when `x` structurally satisfies the {@link Network} protocol. */
export function isNetwork(x: unknown): x is Network {
  return missingMembers(x, NETWORK_METHODS).length === 0;
}

/** True when `x` structurally satisfies the {@link Source} protocol. */
export function isSource(x: unknown): x is Source {
  return missingMembers(x, SOURCE_METHODS, SOURCE_PROPS).length === 0;
}

/** Throw a `TypeError` naming the missing members unless `x` is a {@link Network}. */
export function assertNetwork(x: unknown, name = "network"): asserts x is Network {
  const missing = missingMembers(x, NETWORK_METHODS);
  if (missing.length > 0) {
    throw new TypeError(`${name} does not satisfy the Network protocol; missing: ${missing.join(", ")}`);
  }
}

/** Throw a `TypeError` naming the missing members unless `x` is a {@link Source}. */
export function assertSource(x: unknown, name = "source"): asserts x is Source {
  const missing = missingMembers(x, SOURCE_METHODS, SOURCE_PROPS);
  if (missing.length > 0) {
    throw new TypeError(`${name} does not satisfy the Source protocol; missing: ${missing.join(", ")}`);
  }
}
