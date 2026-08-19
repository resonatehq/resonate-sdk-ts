// =============================================================================
// PostgresConnection
// =============================================================================
// A dual-role connection (`Network` + `Source`) whose server *is* Postgres:
// the Resonate protocol runs as stored procedures in a `resonate` schema (see
// github.com/resonatehq/resonate-pg).
//
//   send(req)  -> `SELECT resonate.resonate_rpc($1::jsonb)`, which runs the
//                 stored procedure for the request kind and returns the exact
//                 wire Response. All protocol logic lives in SQL.
//   recv(cb)   -> a dedicated LISTEN connection on this node's per-address
//                 channels (`resonate.outbox_channel` of the unicast and
//                 anycast). On each notification (and on a short fallback
//                 interval) it drives `process_timeouts()` and dequeues this
//                 node's outbox rows, delivering each as an `execute` /
//                 `unblock` Message. This pump is the runtime: it forwards
//                 server-pushed messages and advances Postgres's timers.
import type { Logger, Message, Network, Request, Response, Source } from "@resonatehq/base";
import pg, { type Client, type Pool } from "pg";

export interface PostgresConnectionConfig {
  /** Postgres connection string (e.g. postgres://user:pass@host:5432/db). */
  connectionString: string;
  /** Worker group; a task targets the group (anycast). Default "default". */
  group?: string;
  /** This process's id; a callback/listener targets it (unicast). Defaults to a random id. */
  pid?: string;
  /** Fallback poll interval (ms) so timers still fire if a NOTIFY is missed. */
  tickMs?: number;
  logger?: Logger;
}

export class PostgresConnection implements Network, Source {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private readonly connectionString: string;
  private readonly tickMs: number;
  private readonly logger?: Logger;

  // The pool is memoized so send() works even before start() resolves (the
  // SDK does not await start()).
  private pool?: Pool;
  private listenClient?: Client;

  private callbacks: Array<(msg: Message) => void> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private redrain = false;
  private stopped = false;

  constructor(cfg: PostgresConnectionConfig) {
    this.connectionString = cfg.connectionString;
    this.group = cfg.group ?? "default";
    this.pid = cfg.pid ?? crypto.randomUUID().replace(/-/g, "");
    this.tickMs = cfg.tickMs ?? 250;
    this.logger = cfg.logger;
    // A task targets the group (anycast); a callback/listener targets this
    // specific process (unicast). The poll:// scheme mirrors the poll
    // adapter's addressing and is what the schema accepts for listeners.
    this.unicast = `poll://uni@${this.group}/${this.pid}`;
    this.anycast = `poll://any@${this.group}`;
  }

  match(target: string): string {
    return `poll://any@${target}`;
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({ connectionString: this.connectionString, max: 8 });
    }
    return this.pool;
  }

  async start(): Promise<void> {
    const pool = this.getPool();
    // A dedicated connection held open for LISTEN; node-postgres surfaces
    // notifications as 'notification' events. The schema NOTIFYs on a channel
    // derived from each row's address, so listen on this node's addresses.
    this.listenClient = new pg.Client({ connectionString: this.connectionString });
    await this.listenClient.connect();
    this.listenClient.on("notification", () => void this.drain());
    this.listenClient.on("error", (err: Error) =>
      this.logger?.warn({ component: "network", error: err.message }, "postgres listen error"),
    );
    for (const address of [this.unicast, this.anycast]) {
      const { rows } = await pool.query("SELECT resonate.outbox_channel($1) AS channel", [address]);
      await this.listenClient.query(`LISTEN "${rows[0].channel}"`);
    }

    this.scheduleNext();
    await this.drain();
    this.logger?.info({ component: "network", group: this.group, pid: this.pid }, "postgres connection started");
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
      await this.pool?.end();
    } catch {
      /* already closed */
    }
  }

  send = async <K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
  ): Promise<Extract<Response, { kind: K }>> => {
    const { rows } = await this.getPool().query("SELECT resonate.resonate_rpc($1::jsonb) AS res", [
      JSON.stringify(req),
    ]);
    return rows[0].res as Extract<Response, { kind: K }>;
  };

  recv(callback: (msg: Message) => void): void {
    this.callbacks.push(callback);
  }

  // --- runtime pump ---------------------------------------------------------
  private deliver(msg: Message) {
    for (const cb of this.callbacks) cb(msg);
  }

  /** Fire due timers, then dequeue this node's outbox rows, delivering each. */
  private async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) {
      this.redrain = true; // coalesce concurrent wakes into one pass
      return;
    }
    this.draining = true;
    try {
      const pool = this.getPool();
      // No-arg overload: timers fire on database time (clock_timestamp), so
      // every node shares one time authority regardless of local clock skew,
      // and concurrent calls from multiple nodes are safe (advisory locks,
      // idempotent handlers).
      await pool.query("SELECT resonate.process_timeouts()");
      // Addressed, destructive dequeue (FOR UPDATE SKIP LOCKED): this node
      // only consumes rows addressed to it, and same-group nodes split the
      // anycast stream. Delivery is at-least-once: if we crash after
      // dequeuing an execute row but before the task is claimed, the task
      // stays pending and the server re-emits it on the task retry timeout
      // (stale duplicates fail acquire with a 409, which the SDK tolerates).
      // Execute rows target the task's target address (anycast by default);
      // unblock rows target the listener's address (this node's unicast).
      for (const address of [this.anycast, this.unicast]) {
        await this.dequeue(pool, "SELECT task_id, version FROM resonate.dequeue_execute($1, $2)", address, (r) =>
          this.deliver({ kind: "execute", head: {}, data: { task: { id: r.task_id, version: r.version } } }),
        );
      }
      await this.dequeue(pool, "SELECT promise FROM resonate.dequeue_unblock($1, $2)", this.unicast, (r) =>
        this.deliver({ kind: "unblock", head: {}, data: { promise: r.promise } }),
      );
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
      this.scheduleNext();
    }
  }

  /** Dequeue rows addressed to `address` in batches until the backlog is empty. */
  private async dequeue(pool: Pool, sql: string, address: string, deliver: (row: any) => void): Promise<void> {
    const limit = 100;
    while (true) {
      const { rows } = await pool.query(sql, [address, limit]);
      for (const r of rows) deliver(r);
      if (rows.length < limit) return;
    }
  }

  /** Fallback tick so timers and missed NOTIFYs still advance the pump. */
  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), this.tickMs);
  }
}
