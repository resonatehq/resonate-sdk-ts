// =============================================================================
// PostgresNetwork
// =============================================================================
// A `Network` whose server *is* Postgres: the Resonate protocol runs as stored
// procedures in a `resonate` schema (see github.com/resonatehq/resonate-postgres).
//
//   send(req)  -> `SELECT resonate.resonate_rpc($1::jsonb)`, which runs the
//                 stored procedure for the request kind and returns the exact
//                 wire Response. All protocol logic lives in SQL.
//   recv(cb)   -> a dedicated LISTEN connection on `resonate_outbox` /
//                 `resonate_timeout`. On any notification (and on a short
//                 fallback interval) it drives `process_timeouts(now)` and drains
//                 the `outbox`, delivering each row as an `execute` / `unblock`
//                 Message. This pump is the runtime: it forwards server-pushed
//                 messages and advances Postgres's (schedulerless) timers.
//
// `pg` (node-postgres) is an optional peer dependency, imported dynamically so
// the SDK carries no hard dependency on it unless PostgresNetwork is used.
import type { Client, Pool } from "pg";
import type { Logger } from "../logger.js";
import type { Network } from "./network.js";
import type { Message, Request, Response } from "./types.js";

export interface PostgresNetworkConfig {
  /** Postgres connection string (e.g. postgres://user:pass@host:5432/db). */
  connectionString: string;
  /** Worker group; a task targets the group (anycast). Default "default". */
  group?: string;
  /** This process's id; a callback/listener targets it (unicast). */
  pid?: string;
  /** Fallback poll interval (ms) so timers still fire if a NOTIFY is missed. */
  tickMs?: number;
  logger?: Logger;
}

export class PostgresNetwork implements Network {
  readonly unicast: string;
  readonly anycast: string;

  private readonly connectionString: string;
  private readonly group: string;
  private readonly pid: string;
  private readonly tickMs: number;
  private readonly logger?: Logger;

  // `pg` is loaded lazily (optional peer dependency); the pool is memoized so
  // send() works even before init() resolves (the SDK does not await init()).
  private poolPromise?: Promise<Pool>;
  private listenClient?: Client;

  private callbacks: Array<(msg: Message) => void> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private redrain = false;
  private stopped = false;

  constructor(cfg: PostgresNetworkConfig) {
    this.connectionString = cfg.connectionString;
    this.group = cfg.group ?? "default";
    this.pid = cfg.pid ?? "node";
    this.tickMs = cfg.tickMs ?? 250;
    this.logger = cfg.logger;
    // A task targets the group (anycast); a callback/listener targets this
    // specific process (unicast).
    this.unicast = `postgres://uni@${this.group}/${this.pid}`;
    this.anycast = `postgres://any@${this.group}`;
  }

  match(target: string): string {
    return `postgres://any@${target}`;
  }

  private async pg(): Promise<{ Pool: typeof Pool; Client: typeof Client }> {
    const m = (await import("pg")) as unknown as {
      Pool?: typeof Pool;
      Client?: typeof Client;
      default?: { Pool: typeof Pool; Client: typeof Client };
    };
    const PoolCtor = (m.Pool ?? m.default?.Pool)!;
    const ClientCtor = (m.Client ?? m.default?.Client)!;
    return { Pool: PoolCtor, Client: ClientCtor };
  }

  private getPool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = this.pg().then((pg) => new pg.Pool({ connectionString: this.connectionString, max: 8 }));
    }
    return this.poolPromise;
  }

  async init(): Promise<void> {
    await this.getPool();
    // A dedicated connection held open for LISTEN; node-postgres surfaces
    // notifications as 'notification' events.
    const pg = await this.pg();
    this.listenClient = new pg.Client({ connectionString: this.connectionString });
    await this.listenClient.connect();
    this.listenClient.on("notification", () => void this.drain());
    this.listenClient.on("error", (err: Error) =>
      this.logger?.warn({ component: "network", error: err.message }, "postgres listen error"),
    );
    await this.listenClient.query("LISTEN resonate_outbox");
    await this.listenClient.query("LISTEN resonate_timeout");

    await this.scheduleNext();
    await this.drain();
    this.logger?.info({ component: "network", group: this.group, pid: this.pid }, "postgres network initialized");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.listenClient?.end();
    } catch {
      /* already closed */
    }
    try {
      await (await this.poolPromise)?.end();
    } catch {
      /* already closed */
    }
  }

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    const pool = await this.getPool();
    const { rows } = await pool.query("SELECT resonate.resonate_rpc($1::jsonb) AS res", [JSON.stringify(req)]);
    return rows[0].res as Extract<Response, { kind: K }>;
  };

  recv(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }

  // --- runtime pump ---------------------------------------------------------
  private deliver(msg: Message) {
    for (const cb of this.callbacks) cb(msg);
  }

  /** Fire due timers, then flush the outbox, delivering each message. */
  private async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) {
      this.redrain = true; // coalesce concurrent wakes into one pass
      return;
    }
    this.draining = true;
    try {
      const pool = await this.getPool();
      await pool.query("SELECT resonate.process_timeouts($1)", [Date.now()]);
      const { rows } = await pool.query(
        `WITH d AS (DELETE FROM resonate.outbox RETURNING *)
         SELECT kind, address, task_id, version, promise FROM d ORDER BY seq`,
      );
      for (const r of rows) {
        if (r.kind === "execute") {
          this.deliver({ kind: "execute", head: {}, data: { task: { id: r.task_id, version: r.version } } });
        } else {
          this.deliver({ kind: "unblock", head: {}, data: { promise: r.promise } });
        }
      }
    } catch (err) {
      if (!this.stopped) {
        this.logger?.warn({ component: "network", error: (err as Error).message }, "postgres drain error");
      }
    } finally {
      this.draining = false;
      if (this.redrain) {
        this.redrain = false;
        void this.drain();
      }
      await this.scheduleNext();
    }
  }

  /** Sleep until the earliest timer deadline (capped at tickMs), waking early on NOTIFY. */
  private async scheduleNext(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    let delay = this.tickMs;
    try {
      const pool = await this.getPool();
      const { rows } = await pool.query("SELECT resonate.next_deadline() AS dl");
      const dl = rows[0]?.dl;
      if (dl != null) {
        delay = Math.max(5, Math.min(this.tickMs, Number(dl) - Date.now()));
      }
    } catch {
      /* fall back to tickMs */
    }
    this.timer = setTimeout(() => void this.drain(), delay);
  }
}
