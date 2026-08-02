// =============================================================================
// SCHEMA
// =============================================================================
//
// Two shapes of database back the decentralized network.
//
//   ORIGIN database — one per workflow. Everything the protocol reads or
//   writes while advancing a single workflow lives here: its promises, the
//   callbacks and listeners registered against them, its tasks, the armed
//   timeouts, and the outbox the transition relation appends messages to.
//   Every request is served by exactly one origin database, which is what
//   makes a request a single-database transaction.
//
//   TENANT database — one per tenant, shared by every origin. It holds the
//   things no single workflow owns: the timeout index (so a sweeper can find
//   due timers without opening every origin database), the message index (so
//   a process can find messages addressed to it without opening every origin
//   database), and schedules (which are tenant-scoped by definition — their
//   promise ids are templates, so a schedule belongs to no one origin).
//
// The tenant tables are *indexes*, never the authority. The origin database
// is the authority for both timers and messages; the tenant rows are
// mirrored from it after each commit. A stale index entry is harmless: every
// timeout transition re-checks its own due time against the origin database
// before acting (the spec's NOT BEFORE rule), and a duplicated message is
// refused by the version fence. A *missing* index entry only delays work —
// the origin database still holds the truth, and the next flush restores it.
//
// Turso does not support generated columns without an experimental flag, so
// the tag-derived columns (`target`, `branch`, `timer`, `external`) are
// written by the caller rather than computed by the engine. `external` is the
// spec's `PromiseObject.external`: explicitly tagged, targeted, or a timer.

/** Bumped when the physical layout changes in a way old rows cannot satisfy. */
export const SCHEMA_VERSION = 1;

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

  // Messages the transition relation emitted, durable because they are
  // written in the same transaction as the state change that produced them.
  // `msg_key` implements the spec's collapse-on-set: an execute message is
  // keyed by task id (a newer dispatch supersedes an older one), an unblock
  // message by promise and address.
  `CREATE TABLE IF NOT EXISTS outbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     msg_key TEXT NOT NULL UNIQUE,
     address TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
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

  // The tenant-global message index. Receivers poll this table instead of
  // opening every origin database; rows are forwarded here from the origin
  // outboxes after commit and claimed destructively by the receiver.
  `CREATE TABLE IF NOT EXISTS messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     msg_key TEXT NOT NULL UNIQUE,
     origin TEXT NOT NULL,
     address TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_address ON messages (address, seq)`,

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
