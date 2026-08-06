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

export interface TursoStoreConfig {
  driver: TursoDriver;
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
  private closed = false;

  constructor(cfg: TursoStoreConfig) {
    this.cfg = cfg;
  }

  // ---------------------------------------------------------------------------
  // CONNECTIONS
  // ---------------------------------------------------------------------------

  tenant(): Promise<TursoConnection> {
    if (!this.tenantConn) {
      this.tenantConn = this.cfg.driver.open(`${this.cfg.prefix}${this.cfg.timeoutDatabase}`).then(async (conn) => {
        await migrate(conn, TENANT_SCHEMA);
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
    const existing = this.origins.get(origin);
    if (existing) {
      // Refresh recency.
      this.origins.delete(origin);
      this.origins.set(origin, existing);
      return existing;
    }

    const opening = this.cfg.driver.open(`${this.cfg.prefix}${origin}`).then(async (conn) => {
      await migrate(conn, ORIGIN_SCHEMA);
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
    this.locks.set(
      origin,
      next.catch(() => {}),
    );
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
  async flush(origin: string, conn: TursoConnection): Promise<void> {
    if (this.closed) return;

    // Local writes first: the tenant index must never advertise a timer whose
    // origin database the remote cannot yet serve to whoever picks it up.
    await conn.push?.();

    const timeouts = await conn.transaction((tx) => readTimeouts(tx));

    const tenant = await this.tenant();
    await tenant.transaction(async (tx) => {
      await tx.execute("DELETE FROM timeouts WHERE origin = ?", [origin]);
      for (const t of timeouts) {
        await tx.execute(
          "INSERT INTO timeouts (origin, id, kind, timeout_at) VALUES (?, ?, ?, ?) ON CONFLICT (origin, id, kind) DO UPDATE SET timeout_at = excluded.timeout_at",
          [origin, t.id, t.kind, t.timeout_at],
        );
      }
    });
    await tenant.push?.();
  }

  /**
   * Close every open connection, leaving the store usable — the next access
   * reopens. Distinct from `close`, which also marks the store shut down so a
   * late flush cannot resurrect it.
   */
  async discard(): Promise<void> {
    const conns = [...this.origins.values()];
    this.origins.clear();
    this.locks.clear();
    const tenant = this.tenantConn;
    this.tenantConn = undefined;
    for (const conn of [...conns, tenant]) {
      try {
        await (await conn)?.close();
      } catch {
        /* already closed */
      }
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
 */
async function migrate(conn: TursoConnection, statements: string[]): Promise<void> {
  for (const sql of statements) await conn.execute(sql);
  const rows = await conn.execute("SELECT value FROM meta WHERE key = 'schema_version'");
  const found = rows.length > 0 ? Number(rows[0].value) : null;
  if (found === null) {
    await conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    return;
  }
  if (found > SCHEMA_VERSION) {
    throw new Error(
      `Turso database is at schema version ${found}, newer than this SDK understands (${SCHEMA_VERSION})`,
    );
  }
  if (found < SCHEMA_VERSION) {
    // Every version so far has only added or dropped tables, and the DDL above
    // is idempotent, so catching up is just restamping. A table this version no
    // longer uses is left in place rather than dropped — an older SDK sharing
    // the database still reads it.
    await conn.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION)]);
  }
}
