// =============================================================================
// DRIVER
// =============================================================================
//
// The decentralized network needs one thing from Turso: the ability to open a
// database *by name* and run transactions against it. That is the whole
// contract, expressed below as `TursoDriver`.
//
// Keeping it this small is deliberate. "One database per workflow" means the
// network opens databases the caller never named in advance, so the mapping
// from a logical database name (`<prefix><origin>`) to a physical database —
// a local file, an embedded replica that syncs to Turso Cloud, a remote HTTP
// database — is a deployment decision, not a protocol decision. Three drivers
// ship here; a caller with a fourth arrangement implements the interface.
//
// All three client packages are optional peer dependencies, imported
// dynamically so the SDK carries no hard dependency on any of them.

/** A row, keyed by column name. */
export type TursoRow = Record<string, any>;

/** The statement-running surface, available on both connections and transactions. */
export interface TursoExecutor {
  /** Run one statement and return its rows (empty for non-SELECT statements). */
  execute(sql: string, args?: unknown[]): Promise<TursoRow[]>;
}

/** An open database. */
export interface TursoConnection extends TursoExecutor {
  /** Run `fn` inside a single write transaction, committing on success. */
  transaction<T>(fn: (tx: TursoExecutor) => Promise<T>): Promise<T>;

  /**
   * Pull remote changes into this replica, if the driver replicates.
   * Returns `true` when new changes arrived. Absent on local-only drivers.
   */
  pull?(): Promise<boolean>;

  /** Push local changes to the remote, if the driver replicates. */
  push?(): Promise<void>;

  close(): Promise<void>;
}

/**
 * Opens databases by name.
 *
 * `name` is the fully-qualified logical database name the network computed —
 * `<prefix><origin>` for a workflow, `<prefix><timeoutDatabase>` for the
 * tenant database. A driver maps that name onto physical storage.
 */
export interface TursoDriver {
  open(name: string): Promise<TursoConnection>;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * How long a connection waits for the write lock before giving up. Several
 * processes may share one origin database, and a request is a short
 * transaction, so queueing beats failing.
 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Map a logical database name to a filesystem path.
 *
 * Origins are validated by the protocol (`resonate:origin` must not contain a
 * `.`) but a database name still reaches the filesystem, so anything that
 * could escape the directory is rejected rather than sanitized — silently
 * rewriting a name would make two distinct origins share one database.
 */
export function databasePath(dir: string, name: string, suffix = ".db"): string {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`Invalid database name: ${JSON.stringify(name)}`);
  }
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${base}/${name}${suffix}`;
}

/** Rows come back as objects from every supported client; normalize `undefined` away. */
function toRows(rows: unknown): TursoRow[] {
  return Array.isArray(rows) ? (rows as TursoRow[]) : [];
}

/**
 * A gate that runs one operation at a time, in call order.
 *
 * Cross-process contention is SQLite's business — that is what `busy_timeout`
 * is for. *In-process* contention on a single connection is ours: a second
 * `BEGIN` on a connection that already has one open is not a wait, it is an
 * error.
 */
function onePerConnection(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

// =============================================================================
// LOCAL DRIVER (@tursodatabase/database)
// =============================================================================

export interface TursoLocalDriverConfig {
  /**
   * Directory holding one file per database. Pass `":memory:"` to keep every
   * database in memory — each name still gets its own isolated database, which
   * is what tests want.
   *
   * Only one process may use a given directory: see `tursoLocalDriver`.
   */
  dir: string;
  /** File suffix for on-disk databases. Default ".db". */
  suffix?: string;
}

/**
 * A driver backed by `@tursodatabase/database`: embedded, local-only, no
 * replication.
 *
 * ONE PROCESS ONLY. Turso takes an exclusive file lock when it opens a
 * database, so a second process opening the same file fails outright with
 * "File is locked by another process" — a shared directory is not a way to run
 * a fleet. Use it for a single node, for tests, and for `:memory:`.
 */
export function tursoLocalDriver(cfg: TursoLocalDriverConfig): TursoDriver {
  return {
    async open(name: string): Promise<TursoConnection> {
      const mod: any = await import("@tursodatabase/database");
      const connect = mod.connect ?? mod.default?.connect;
      const path = cfg.dir === ":memory:" ? ":memory:" : databasePath(cfg.dir, name, cfg.suffix);
      const conn = wrapDatabasePromise(await connect(path));
      // Busy timeout first: switching to WAL takes an exclusive lock of its
      // own, so arming the timeout afterwards leaves that very statement
      // unprotected against a concurrent opener.
      await conn.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      if (path !== ":memory:") await conn.execute("PRAGMA journal_mode = WAL");
      return conn;
    },
  };
}

// =============================================================================
// SYNC DRIVER (@tursodatabase/sync)
// =============================================================================

export interface TursoSyncDriverConfig {
  /** Directory holding the local replica files, one set per database. */
  dir: string;
  /** File suffix for the local replica. Default ".db". */
  suffix?: string;
  /**
   * The remote database for a given name. Pass a string to use it as a URL
   * prefix (`${url}${name}`), or a function for full control — a Turso Cloud
   * deployment typically names one remote database per workflow, so the
   * prefix form is usually enough.
   */
  url: string | ((name: string) => string);
  /** Auth token, or a function producing a short-lived one per request. */
  authToken?: string | (() => Promise<string>);
  /** Client name reported to the remote; the library appends a unique suffix. */
  clientName?: string;
  /** Long-poll timeout (ms) for `pull()`. */
  longPollTimeoutMs?: number;
  /**
   * Execute writes on the remote rather than on the local replica.
   *
   * THIS IS WHAT MAKES THE PROTOCOL'S COMPARE-AND-SWAP SOUND ACROSS NODES.
   * `task.acquire` and every other fenced action is a read-compare-write inside
   * one transaction — a genuine CAS, atomic against whichever database applies
   * it. With local writes each node applies that CAS to *its own replica* and
   * the copies merge afterwards, so two nodes can both win the same acquire and
   * both believe they hold the task. Sending writes to the remote restores the
   * single serialization point the fence needs.
   *
   * Because state is partitioned one database per workflow, this serializes
   * *per workflow*, not globally — two different workflows never contend.
   *
   * Leave it off only when a workflow has exactly one writer (a single node, or
   * a fleet where nothing steals work). Default false, because the underlying
   * flag is still marked experimental upstream.
   */
  remoteWrites?: boolean;
  /** Extra options forwarded verbatim to `@tursodatabase/sync`'s `connect`. */
  options?: Record<string, unknown>;
}

/**
 * A driver backed by `@tursodatabase/sync`: an embedded replica per database
 * that pulls from and pushes to Turso Cloud. This is the decentralized
 * arrangement — every process holds a local copy of the workflows it is
 * working on, reads and writes it at local-disk latency, and converges with
 * everyone else through the remote.
 */
export function tursoSyncDriver(cfg: TursoSyncDriverConfig): TursoDriver {
  const urlFor = typeof cfg.url === "function" ? cfg.url : (name: string) => `${cfg.url}${name}`;
  return {
    async open(name: string): Promise<TursoConnection> {
      const mod: any = await import("@tursodatabase/sync");
      const connect = mod.connect ?? mod.default?.connect;
      const db = await connect({
        ...cfg.options,
        path: databasePath(cfg.dir, name, cfg.suffix),
        url: urlFor(name),
        authToken: cfg.authToken,
        clientName: cfg.clientName,
        longPollTimeoutMs: cfg.longPollTimeoutMs,
        remoteWritesExperimental: cfg.remoteWrites,
      });
      const conn = wrapDatabasePromise(db, cfg.remoteWrites === true);
      // Only the busy timeout: the sync engine owns this database's journal
      // mode, so setting it here would fight the replica machinery.
      await conn.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      conn.pull = async () => await db.pull();
      conn.push = async () => {
        await db.push();
      };
      return conn;
    },
  };
}

// =============================================================================
// LIBSQL DRIVER (@libsql/client)
// =============================================================================

export interface LibsqlDriverConfig {
  /**
   * The connection URL for a given name. A string is used as a prefix
   * (`${url}${name}`) — e.g. `"file:/var/lib/resonate/"` or
   * `"libsql://acme-"` — and a function gives full control.
   */
  url: string | ((name: string) => string);
  authToken?: string;
  /** Local replica path for embedded-replica mode, per name. */
  syncUrl?: (name: string) => string;
  /** Extra options forwarded verbatim to `createClient`. */
  options?: Record<string, unknown>;
}

/** A driver backed by `@libsql/client`, for deployments already standardized on it. */
export function libsqlDriver(cfg: LibsqlDriverConfig): TursoDriver {
  const urlFor = typeof cfg.url === "function" ? cfg.url : (name: string) => `${cfg.url}${name}`;
  return {
    async open(name: string): Promise<TursoConnection> {
      const mod: any = await import("@libsql/client");
      const createClient = mod.createClient ?? mod.default?.createClient;
      const client = createClient({
        ...cfg.options,
        url: urlFor(name),
        authToken: cfg.authToken,
        ...(cfg.syncUrl ? { syncUrl: cfg.syncUrl(name) } : {}),
      });

      // Serialize everything on this client. A libSQL client holds one
      // connection, so two overlapping write transactions on it do not queue —
      // the second `BEGIN` fails with SQLITE_BUSY immediately, without ever
      // consulting the busy timeout. That is easy to hit: a node flushing
      // several origins at once issues concurrent transactions against the one
      // tenant database. The Turso drivers get this serialization from
      // `transactionAsync`, which owns the connection for the whole window;
      // here it has to be explicit.
      const serialize = onePerConnection();

      const conn: TursoConnection = {
        execute(sql: string, args: unknown[] = []): Promise<TursoRow[]> {
          return serialize(async () => {
            const rs = await client.execute({ sql, args: args as any[] });
            // libSQL rows are array-like with named properties; copy the named
            // half so callers see a plain object regardless of client version.
            return (rs.rows ?? []).map((row: any) => ({ ...row }));
          });
        },
        transaction<T>(fn: (tx: TursoExecutor) => Promise<T>): Promise<T> {
          return serialize(async () => {
            const tx = await client.transaction("write");
            try {
              const result = await fn({
                async execute(sql: string, args: unknown[] = []) {
                  const rs = await tx.execute({ sql, args: args as any[] });
                  return (rs.rows ?? []).map((row: any) => ({ ...row }));
                },
              });
              await tx.commit();
              return result;
            } catch (err) {
              await tx.rollback().catch(() => {});
              throw err;
            }
          });
        },
        async close(): Promise<void> {
          client.close();
        },
      };
      // Busy timeout first, then WAL: the WAL switch takes an exclusive lock
      // of its own. Unlike the Turso drivers this one really is shared across
      // processes — a `file:` libSQL database uses ordinary SQLite locking — so
      // without the timeout concurrent nodes get SQLITE_BUSY rather than
      // queueing for the write lock.
      await conn.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      if (urlFor(name).startsWith("file:")) {
        await conn.execute("PRAGMA journal_mode = WAL");
      }

      if (typeof client.sync === "function") {
        conn.pull = async () => {
          await client.sync();
          return true;
        };
      }
      return conn;
    },
  };
}

// =============================================================================
// SHARED WRAPPER
// =============================================================================

/**
 * Adapt a `@tursodatabase/*` `DatabasePromise` to `TursoConnection`.
 *
 * A request is one transaction, and the protocol's compare-and-swap guards are
 * only sound if that transaction is isolated. Two paths get there:
 *
 *   Local writes (default) — `transactionAsync` owns the connection for the
 *   whole BEGIN..COMMIT window, so nothing can interleave.
 *
 *   Remote writes — `transactionAsync` is not supported in that mode (the
 *   transaction runs on the remote and has no local connection to hand out),
 *   so the deprecated `transaction` wrapper is used and isolation comes from
 *   our own gate in-process plus the remote's serialization across processes.
 */
function wrapDatabasePromise(db: any, remoteWrites = false): TursoConnection {
  const gate = onePerConnection();

  /** Statements issued straight at `db`, bypassing the gate that already holds it. */
  const direct: TursoExecutor = {
    async execute(sql: string, args: unknown[] = []) {
      const stmt = await db.prepare(sql);
      return toRows(await stmt.all(...args));
    },
  };

  return {
    async execute(sql: string, args: unknown[] = []): Promise<TursoRow[]> {
      return remoteWrites ? await gate(() => direct.execute(sql, args)) : await direct.execute(sql, args);
    },
    async transaction<T>(fn: (tx: TursoExecutor) => Promise<T>): Promise<T> {
      if (remoteWrites) {
        return await gate(async () => {
          const run = db.transaction(async () => await fn(direct));
          return (await run.immediate()) as T;
        });
      }
      const run = db.transactionAsync(async (txn: any) => {
        return await fn({
          async execute(sql: string, args: unknown[] = []) {
            const stmt = await txn.prepare(sql);
            return toRows(await stmt.all(...args));
          },
        });
      });
      return await run.immediate();
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
