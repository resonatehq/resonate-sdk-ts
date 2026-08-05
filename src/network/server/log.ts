// =============================================================================
// ORIGIN LOG — the commit unit
// =============================================================================
//
// State is partitioned by *origin* (the lineage root: the id up to the first
// `.`), and each origin's history is an append-only log of `Change[]` batches.
// One batch is one request's complete write set — state mutations, timeout
// registrations and outgoing messages together — so a commit is atomic by
// construction. There is no "save the state, then publish the effects" window,
// which is the gap that lets a crashed lineage go permanently dark.
//
// Appends are conditional on the caller's view of the log head. A mismatch
// raises {@link ConflictError}, which the runtime resolves by re-materializing
// and re-running the request. This is optimistic concurrency: correct without
// coordination, and cheap when a serializing consumer keeps conflicts rare.

import type { Change } from "../local.js";
import type { Snapshot } from "./state.js";

/** One committed batch. `seq` is the origin-local sequence number, from 1. */
export interface LogEntry {
  seq: number;
  changes: Change[];
}

/** Raised when an append's `expectedSeq` does not match the log head. */
export class ConflictError extends Error {
  constructor(
    readonly origin: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`append conflict on origin "${origin}": expected seq ${expected}, found ${actual}`);
    this.name = "ConflictError";
  }
}

export interface OriginLog {
  /**
   * Append a batch, conditional on `expectedSeq` being the current head.
   * Returns the new head sequence. Throws {@link ConflictError} on a lost race.
   */
  append(origin: string, changes: Change[], expectedSeq: number): Promise<number>;

  /** Entries with `seq > fromSeq`, in order. */
  read(origin: string, fromSeq: number): Promise<LogEntry[]>;

  /** Current head sequence, or 0 when the origin has no history. */
  head(origin: string): Promise<number>;

  /** Discard entries at or below `throughSeq`; they must be covered by a snapshot. */
  trim(origin: string, throughSeq: number): Promise<void>;

  /**
   * Every origin with history. The timeout sweeper walks this to find lineages
   * with work due; nothing else depends on it, so a backing store that cannot
   * enumerate cheaply can maintain a separate index instead.
   */
  origins(): Promise<string[]>;
}

export interface SnapshotStore {
  load(origin: string): Promise<{ snapshot: Snapshot; seq: number } | undefined>;
  save(origin: string, snapshot: Snapshot, seq: number): Promise<void>;
}

// =============================================================================
// IN-MEMORY IMPLEMENTATIONS
// =============================================================================

/**
 * Reference implementation. Semantics — conditional append, ordered reads,
 * trimming — match what a JetStream-backed log provides, so the runtime and its
 * tests can be exercised without a broker.
 */
export class MemoryLog implements OriginLog {
  private logs = new Map<string, LogEntry[]>();
  // Entries dropped by `trim` still count towards sequence numbering, so a
  // trimmed log does not renumber and snapshot cursors stay valid.
  private trimmed = new Map<string, number>();

  async append(origin: string, changes: Change[], expectedSeq: number): Promise<number> {
    const entries = this.logs.get(origin) ?? [];
    const current = this.headOf(origin, entries);
    if (current !== expectedSeq) {
      throw new ConflictError(origin, expectedSeq, current);
    }
    const seq = current + 1;
    // Deep-copy on write: a caller must not be able to mutate committed
    // history by holding on to the array it passed in.
    entries.push({ seq, changes: structuredClone(changes) });
    this.logs.set(origin, entries);
    return seq;
  }

  async read(origin: string, fromSeq: number): Promise<LogEntry[]> {
    const entries = this.logs.get(origin) ?? [];
    return structuredClone(entries.filter((e) => e.seq > fromSeq));
  }

  async head(origin: string): Promise<number> {
    return this.headOf(origin, this.logs.get(origin) ?? []);
  }

  async trim(origin: string, throughSeq: number): Promise<void> {
    const entries = this.logs.get(origin) ?? [];
    const kept = entries.filter((e) => e.seq > throughSeq);
    this.logs.set(origin, kept);
    this.trimmed.set(origin, Math.max(this.trimmed.get(origin) ?? 0, throughSeq));
  }

  async origins(): Promise<string[]> {
    return [...new Set([...this.logs.keys(), ...this.trimmed.keys()])];
  }

  private headOf(origin: string, entries: LogEntry[]): number {
    if (entries.length > 0) return entries[entries.length - 1].seq;
    return this.trimmed.get(origin) ?? 0;
  }

  /** Test helper: total entries retained across all origins. */
  size(): number {
    let n = 0;
    for (const entries of this.logs.values()) n += entries.length;
    return n;
  }
}

export class MemorySnapshotStore implements SnapshotStore {
  private snaps = new Map<string, { snapshot: Snapshot; seq: number }>();

  async load(origin: string): Promise<{ snapshot: Snapshot; seq: number } | undefined> {
    const entry = this.snaps.get(origin);
    return entry ? structuredClone(entry) : undefined;
  }

  async save(origin: string, snapshot: Snapshot, seq: number): Promise<void> {
    const existing = this.snaps.get(origin);
    // Never move a checkpoint backwards; a slow writer must not clobber a
    // newer snapshot written by a peer.
    if (existing && existing.seq >= seq) return;
    this.snaps.set(origin, structuredClone({ snapshot, seq }));
  }
}
