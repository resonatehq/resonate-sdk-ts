// =============================================================================
// SCHEMA
// =============================================================================
//
// Two shapes of database back the decentralized network.
//
//   ORIGIN database — one per workflow. Everything the protocol reads or
//   writes while advancing a single workflow lives here: its promises, the
//   callbacks and listeners registered against them, its tasks, and the armed
//   timeouts. Every request is served by exactly one origin database, which is
//   what makes a request a single-database transaction.
//
//   TENANT database — one per tenant, shared by every origin. It holds the
//   things no single workflow owns: the timeout index (so a sweeper can find
//   due timers without opening every origin database) and schedules (which are
//   tenant-scoped by definition — their promise ids are templates, so a
//   schedule belongs to no one origin).
//
// MESSAGES ARE NOT STORED. `execute` and `unblock` are handed to the local
// Resonate client the moment the transaction that produced them commits; they
// never touch a table. Recovery does not depend on them: an undelivered
// execute is re-emitted by the task's own retry timer, which *is* durable, and
// the timeout index is what lets any process in the tenant find that timer.
//
// The timeout table is an *index*, never the authority. The origin database
// holds the armed timers; the tenant rows are mirrored from it after each
// commit. A stale entry is harmless — every timeout transition re-checks its
// own due time against the origin database before acting (the spec's NOT
// BEFORE rule). A missing entry only delays work; the next flush restores it.
//
// Turso does not support generated columns without an experimental flag, so
// the tag-derived columns (`target`, `branch`, `timer`, `external`) are
// written by the caller rather than computed by the engine. `external` is the
// spec's `PromiseObject.external`: explicitly tagged, targeted, or a timer.

/** Bumped when the physical layout changes in a way old rows cannot satisfy. */
export const SCHEMA_VERSION = 2;

export const ORIGIN_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS promises (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL DEFAULT 'pending'
       CHECK (state IN ('pending', 'resolved', 'rejected', 'rejected_canceled', 'rejected_timedout')),
     param_headers TEXT,
     param_data TEXT,
     value_headers TEXT,
     value_data TEXT,
     tags TEXT NOT NULL DEFAULT '{}',
     target TEXT,
     branch TEXT,
     timer INTEGER NOT NULL DEFAULT 0,
     external INTEGER NOT NULL DEFAULT 0,
     timeout_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     settled_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_promises_branch ON promises (branch) WHERE branch IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_promises_state ON promises (state, id)`,

  // The awaiter ids registered against an awaited promise. `seq` preserves
  // the spec's append order, which fixes the order resumes are deferred in.
  `CREATE TABLE IF NOT EXISTS callbacks (
     awaited_id TEXT NOT NULL,
     awaiter_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     PRIMARY KEY (awaited_id, awaiter_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_callbacks_awaiter ON callbacks (awaiter_id)`,

  `CREATE TABLE IF NOT EXISTS listeners (
     promise_id TEXT NOT NULL,
     address TEXT NOT NULL,
     seq INTEGER NOT NULL,
     PRIMARY KEY (promise_id, address)
   )`,

  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL DEFAULT 'pending'
       CHECK (state IN ('pending', 'acquired', 'suspended', 'halted', 'fulfilled')),
     version INTEGER NOT NULL DEFAULT 0,
     pid TEXT,
     ttl INTEGER
   )`,

  // A task's `resumes` list: awaited ids that settled while the task was not
  // suspended, buffered until it next suspends or continues.
  `CREATE TABLE IF NOT EXISTS resumes (
     task_id TEXT NOT NULL,
     awaited_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     PRIMARY KEY (task_id, awaited_id)
   )`,

  `CREATE TABLE IF NOT EXISTS promise_timeouts (
     id TEXT PRIMARY KEY,
     timeout_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_promise_timeouts_due ON promise_timeouts (timeout_at, id)`,

  // kind 0 = pending retry, kind 1 = lease expiration. A task carries at most
  // one armed timer, but the spec keys `setTaskTimeout` on (id, kind), so the
  // primary key does too; `delTaskTimeout` deletes every kind for the id.
  `CREATE TABLE IF NOT EXISTS task_timeouts (
     id TEXT NOT NULL,
     kind INTEGER NOT NULL,
     timeout_at INTEGER NOT NULL,
     PRIMARY KEY (id, kind)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_task_timeouts_due ON task_timeouts (timeout_at, id)`,
];

export const TENANT_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // The tenant-global timeout index. `kind` widens the origin database's own
  // encoding so promise and task timers share one due-time ordering:
  //   0 = promise timeout, 1 = task retry, 2 = task lease.
  `CREATE TABLE IF NOT EXISTS timeouts (
     origin TEXT NOT NULL,
     id TEXT NOT NULL,
     kind INTEGER NOT NULL,
     timeout_at INTEGER NOT NULL,
     PRIMARY KEY (origin, id, kind)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_timeouts_due ON timeouts (timeout_at, origin)`,

  // Schedules are tenant-scoped: a schedule's promise id is a template, so
  // the promises it fires may land in many origins.
  `CREATE TABLE IF NOT EXISTS schedules (
     id TEXT PRIMARY KEY,
     cron TEXT NOT NULL,
     promise_id TEXT NOT NULL,
     promise_timeout INTEGER NOT NULL,
     promise_param_headers TEXT,
     promise_param_data TEXT,
     promise_tags TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL,
     next_run_at INTEGER NOT NULL,
     last_run_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (next_run_at, id)`,
];
