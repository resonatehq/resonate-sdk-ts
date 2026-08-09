// =============================================================================
// STORE
// =============================================================================
//
// Connection management and the bridge between the two kinds of database.
//
// An origin database is the authority for one workflow. The tenant database
// indexes the due timers across all of them, so a process can find work in a
// workflow it has never heard of without opening every database in the tenant.
// Nothing in the tenant database is trusted: `flush` rebuilds it from the
// origin after every commit, and every consumer re-validates against the
// origin before acting.
//
// `flush` runs after the request's transaction has committed, never inside it:
// a single transaction cannot span two databases, so the mirror is
// deliberately eventual. Crash after commit but before flush and the origin
// still holds the truth — the next flush, or the next request touching this
// origin, republishes it.

import type { Logger } from "../../logger.js";
import type { TursoConnection, TursoDriver, TursoExecutor } from "./driver.js";
import { ORIGIN_SCHEMA, SCHEMA_VERSION, TENANT_SCHEMA } from "./schema.js";
import { hashOrigin } from "./server.js";

export interface TursoStoreConfig {
  driver: TursoDriver;
  /**
   * Opens the tenant database. Defaults to `driver`. Origins are owned by one
   * node; the timeout index is written by all of them, so the two can need
   * different storage — see `TursoNetworkConfig.timeoutDriver`.
   */
  timeoutDriver?: TursoDriver;
  /**
   * Prefix applied to every database name. `"resonate-"` gives an origin
   * database `resonate-<origin>` per workflow and `resonate-timeouts` for the
   * tenant. This is what keeps one tenant's databases from colliding with
   * another's in a shared Turso account.
   */
  prefix: string;
  /** Unprefixed name of the tenant database. Default "timeouts". */
  timeoutDatabase: string;
  /** How many origin databases to keep open. Least-recently-used are closed. */
  maxOpenDatabases: number;
  logger?: Logger;
}

/** The tenant index's timeout kinds, widening the origin database's encoding. */
/**
 * How long a "nothing moved, skip the tenant write" decision stays good.
 * See `TursoStore.published`.
 */
export const REPUBLISH_AFTER_MS = 60_000;

export const TIMEOUT_PROMISE = 0;
export const TIMEOUT_TASK_RETRY = 1;
export const TIMEOUT_TASK_LEASE = 2;

export class TursoStore {
  private readonly cfg: TursoStoreConfig;
  private tenantConn?: Promise<TursoConnection>;
  /** Open origin connections, in least-recently-used order. */
  private readonly origins = new Map<string, Promise<TursoConnection>>();
  /** Serializes work per origin so a request and a flush never interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** How many holders/waiters each origin's lock chain has, so it can be dropped at zero. */
  private readonly holders = new Map<string, number>();
  /**
   * The timer set this process last published per origin.
   *
   * The tenant database is the one file every node in the fleet writes, which
   * makes it the fleet's only global write bottleneck. Most requests do not
   * move a timer — reads never do, and plenty of writes do not either — so
   * publishing unconditionally saturates that file for no reason. Comparing
   * against what we last published turns those into no tenant write at all.
   *
   * A stale skip is possible if another node rewrote this origin's rows
   * underneath us. That is the same class of drift the index already tolerates:
   * consumers re-validate against the origin database before acting, and the
   * next real change here republishes the whole slice.
   *
   * The entry carries when it was published, because "unchanged" is not a safe
   * answer forever: if this origin's slice goes missing from the index by any
   * route this process cannot see (operator tooling, a maintenance job), the
   * fingerprint still matches, the republish is skipped, and — since the sweep
   * finds work only through the index — the origin's timers never fire, so its
   * timer set never changes, so the fingerprint never changes. That is a
   * permanent strand from a transient cause. Expiring the entry bounds it to
   * `REPUBLISH_AFTER_MS`. Per-entry rather than a global clear, so republishes
   * stagger instead of stampeding.
   */
  private readonly published = new Map<string, { fingerprint: string; at: number }>();
  private closed = false;

  constructor(cfg: TursoStoreConfig) {
    this.cfg = cfg;
  }

  // ---------------------------------------------------------------------------
  // CONNECTIONS
  // ---------------------------------------------------------------------------

  tenant(): Promise<TursoConnection> {
    if (this.closed) throw new Error("TursoStore is closed");
    if (!this.tenantConn) {
      const driver = this.cfg.timeoutDriver ?? this.cfg.driver;
      this.tenantConn = driver.open(`${this.cfg.prefix}${this.cfg.timeoutDatabase}`).then(async (conn) => {
        try {
          await migrate(conn, TENANT_SCHEMA);
        } catch (err) {
          await conn.close().catch(() => {});
          throw err;
        }
        return conn;
      });
      // A failed open must not poison the memo — the next call should retry.
      this.tenantConn.catch(() => {
        this.tenantConn = undefined;
      });
    }
    return this.tenantConn;
  }

  origin(origin: string): Promise<TursoConnection> {
    // Total, not just checked in `flush`: reopening after close would leak a
    // connection nothing will ever close, and would let a request that raced
    // `stop()` commit writes the mirror never learns about.
    if (this.closed) throw new Error("TursoStore is closed");
    const existing = this.origins.get(origin);
    if (existing) {
      // Refresh recency.
      this.origins.delete(origin);
      this.origins.set(origin, existing);
      return existing;
    }

    const opening = this.cfg.driver.open(`${this.cfg.prefix}${origin}`).then(async (conn) => {
      try {
        await migrate(conn, ORIGIN_SCHEMA);
      } catch (err) {
        await conn.close().catch(() => {});
        throw err;
      }
      return conn;
    });
    opening.catch(() => this.origins.delete(origin));
    this.origins.set(origin, opening);
    void this.evict();
    return opening;
  }

  private async evict(): Promise<void> {
    while (this.origins.size > this.cfg.maxOpenDatabases) {
      const oldest = this.origins.keys().next();
      if (oldest.done) return;
      const conn = this.origins.get(oldest.value);
      this.origins.delete(oldest.value);
      // `flush` only ever runs against a connection from `origin()`, so an
      // origin is open whenever it publishes: dropping the fingerprint here
      // bounds `published` by `maxOpenDatabases` instead of letting it grow
      // once per origin ever touched. The cost of a dropped entry is one
      // redundant republish, which the mirror already tolerates.
      this.published.delete(oldest.value);
      // Evict behind the per-origin lock so an in-flight transaction is never
      // closed out from under itself.
      await this.withLock(oldest.value, async () => {
        try {
          await (await conn)?.close();
        } catch (err) {
          this.cfg.logger?.warn(
            { component: "network", origin: oldest.value, error: String(err) },
            "turso close failed",
          );
        }
      });
    }
  }

  /**
   * Run `fn` with exclusive access to `origin` within this process.
   *
   * The driver already serializes statements on a connection, but a request is
   * a transaction *followed by* a flush, and those two must not interleave
   * with another request's pair — otherwise a flush could publish a partial
   * view of another request's timers.
   */
  withLock<T>(origin: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(origin) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but never let a rejection escape into the next link.
    const tail = next.catch(() => {});
    this.locks.set(origin, tail);
    // One database per workflow means one map entry per workflow *ever seen*,
    // which is unbounded in a process that runs short-lived workflows — the
    // LRU bounds connections, not this. Drop the entry once nothing is queued
    // on it: identity only has to be stable while a holder or waiter exists,
    // and a later request for a quiet origin can safely start a fresh chain.
    this.holders.set(origin, (this.holders.get(origin) ?? 0) + 1);
    void tail.then(() => {
      const remaining = (this.holders.get(origin) ?? 1) - 1;
      if (remaining > 0) {
        this.holders.set(origin, remaining);
        return;
      }
      this.holders.delete(origin);
      // Only if no one re-chained in the meantime.
      if (this.locks.get(origin) === tail) this.locks.delete(origin);
    });
    return next;
  }

  // ---------------------------------------------------------------------------
  // FLUSH
  // ---------------------------------------------------------------------------

  /**
   * Publish an origin's armed timers to the tenant index.
   *
   * Called after every committed write against an origin. Reading the whole
   * timeout set and replacing the origin's slice of the index — rather than
   * tracking deltas — is deliberate: a workflow's live timer set is small, and
   * a full replace cannot drift, whereas a missed delta would silently strand
   * a timer forever.
   */
  async flush(origin: string, conn: TursoConnection, pushOrigin = true): Promise<void> {
    if (this.closed) return;

    // Local writes first: the tenant index should not advertise a timer whose
    // origin database the remote cannot yet serve to whoever picks it up.
    //
    // `pushOrigin` is false for requests inside a task's tenure: the lease
    // already gives the workflow one writer, so intermediate durable steps
    // stay on the local replica and the upload happens once, at the boundary
    // (complete or suspend). An index entry published while the origin is
    // still unpushed is safe — a consumer re-validates against the origin and
    // treats "not armed yet" exactly like any other stale entry — it just
    // wastes an open per sweep until the boundary push lands.
    if (pushOrigin) await conn.push?.();

    const timeouts = await conn.transaction((tx) => readTimeouts(tx));

    // Nothing moved: leave the shared file alone.
    const fingerprint = timeouts
      .map((t) => `${t.id} ${t.kind} ${t.timeout_at}`)
      .sort()
      .join("");
    const last = this.published.get(origin);
    if (last?.fingerprint === fingerprint && Date.now() - last.at < REPUBLISH_AFTER_MS) return;

    const tenant = await this.tenant();
    await tenant.transaction(async (tx) => {
      await tx.execute("DELETE FROM timeouts WHERE origin = ?", [origin]);
      const hash = hashOrigin(origin);
      for (const t of timeouts) {
        await tx.execute(
          `INSERT INTO timeouts (origin, origin_hash, id, kind, timeout_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (origin, id, kind) DO UPDATE SET timeout_at = excluded.timeout_at,
             origin_hash = excluded.origin_hash`,
          [origin, hash, t.id, t.kind, t.timeout_at],
        );
      }
    });
    await tenant.push?.();
    // Recorded only after the write lands, so a failed publish is retried.
    this.published.set(origin, { fingerprint, at: Date.now() });
  }

  /**
   * Close every open connection, leaving the store usable — the next access
   * reopens. Distinct from `close`, which also marks the store shut down so a
   * late flush cannot resurrect it.
   */
  async discard(): Promise<void> {
    const entries = [...this.origins.entries()];
    this.origins.clear();
    this.published.clear();
    // The locks map is deliberately NOT cleared. A request may be queued on a
    // chain right now; handing a later request a fresh lock for the same
    // origin would let the two run their transaction-and-flush pairs
    // concurrently — the exact interleaving the lock exists to prevent.
    for (const [origin, conn] of entries) {
      // Behind the per-origin lock, for the same reason eviction is: an
      // in-flight transaction must never be closed out from under itself.
      await this.withLock(origin, async () => {
        try {
          await (await conn)?.close();
        } catch {
          /* already closed */
        }
      });
    }
    // Tenant last: an origin's closing flush may still publish to it.
    const tenant = this.tenantConn;
    this.tenantConn = undefined;
    try {
      await (await tenant)?.close();
    } catch {
      /* already closed */
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.discard();
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/** The origin's armed timers, translated into the tenant index's kind encoding. */
async function readTimeouts(tx: TursoExecutor): Promise<{ id: string; kind: number; timeout_at: number }[]> {
  const promises = await tx.execute("SELECT id, timeout_at FROM promise_timeouts");
  const tasks = await tx.execute("SELECT id, kind, timeout_at FROM task_timeouts");
  return [
    ...promises.map((r) => ({ id: r.id as string, kind: TIMEOUT_PROMISE, timeout_at: Number(r.timeout_at) })),
    ...tasks.map((r) => ({
      id: r.id as string,
      kind: Number(r.kind) === 1 ? TIMEOUT_TASK_LEASE : TIMEOUT_TASK_RETRY,
      timeout_at: Number(r.timeout_at),
    })),
  ];
}

/**
 * Create the schema if absent and record its version.
 *
 * Every statement is `IF NOT EXISTS`, so this is safe to run on every open —
 * which it must be, since a database is created the first time a workflow
 * touches it and no separate migration step ever runs against it.
 *
 * It is also safe to run *concurrently*. Several processes routinely open the
 * same database for the first time at the same moment, so the version stamp is
 * claimed with an idempotent insert rather than read-then-insert: the latter
 * loses the race and fails the unique constraint on `meta.key`.
 */
async function migrate(conn: TursoConnection, statements: string[]): Promise<void> {
  for (const sql of statements) await conn.execute(sql);
  await conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING", [
    String(SCHEMA_VERSION),
  ]);

  const rows = await conn.execute("SELECT value FROM meta WHERE key = 'schema_version'");
  const found = rows.length > 0 ? Number(rows[0].value) : SCHEMA_VERSION;
  if (found > SCHEMA_VERSION) {
    throw new Error(
      `Turso database is at schema version ${found}, newer than this SDK understands (${SCHEMA_VERSION})`,
    );
  }
  if (found < SCHEMA_VERSION) {
    // The timeout table is a mirror of the origin databases, but it is also
    // the fleet's only discovery mechanism: an origin whose workflows are all
    // quiescent (suspended, sleeping, delayed) gets no flush until something
    // touches it, and nothing touches it except a sweep — which finds it
    // through this very table. So an upgrade must carry the rows across, not
    // drop them: stale-shaped rows are safe (every consumer re-validates
    // against the origin database), missing rows strand workflows forever.
    // (Guarded: origin databases run this same upgrade path and have no
    // timeouts table. A future version that reshapes the carried columns must
    // adjust the copy below in the same change.)
    const mirror = await conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timeouts'");
    if (mirror.length > 0) await conn.execute("ALTER TABLE timeouts RENAME TO timeouts_old");
    for (const sql of statements) await conn.execute(sql);
    if (mirror.length > 0) {
      await conn.execute(
        `INSERT OR IGNORE INTO timeouts (origin, origin_hash, id, kind, timeout_at)
         SELECT origin, origin_hash, id, kind, timeout_at FROM timeouts_old`,
      );
      await conn.execute("DROP TABLE timeouts_old");
    }
    await conn.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
  }
}
