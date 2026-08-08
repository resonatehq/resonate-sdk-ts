# Release Notes — Decentralized Resonate on Turso

Proposed versions at merge: `@resonatehq/sdk` 0.12.0, `resonate-sdk` (Python) 0.8.0.

## Overview

`TursoNetwork` (`@resonatehq/sdk/turso`) runs the Resonate protocol with no
server: one Turso database per workflow plus a tenant-global timeout index,
served by pluggable drivers (embedded, embedded-replica syncing with Turso
Cloud, libSQL). Shipped in both the TypeScript and Python SDKs with identical
semantics — a mixed fleet shards identically and shares one timer index.

Everything below marked *measured* was demonstrated against a real Turso Cloud
account; see `turso.md` for numbers and `experiments/` for the scripts.

## New Features

- **`TursoNetwork`** — the protocol's full transition relation over Turso
  databases: promises, tasks with fenced leases, callbacks/listeners, durable
  timers, schedules (cron), static fleet sharding (`shard` + `ownerOf`).
- **Three drivers**: `tursoLocalDriver` (embedded), `tursoSyncDriver`
  (embedded replica ↔ Turso Cloud), `libsqlDriver` (libSQL/Hrana); the
  `TursoDriver` interface is one method, `open(name)`.
- **Boundary uploads** (`pushOn: "boundary"`, default): a task tenure's
  intermediate durable steps stay on the local replica; the origin database
  uploads at the boundaries another process could need — task
  fulfill/suspend/release/halt/continue, work births, root settles, external
  settles, suspended-task wakes.
- **Fleet example** (`examples/turso-fleet`): a sharded two-node HTTP app with
  forwarding by `ownerOf`.

## Measured (Turso Cloud, aws-us-west-2)

- Timer visibility through the remote: ~190–220ms median (p90 270–400ms).
- Cross-node pickup of an abandoned workflow: ~2s overhead over its sleep.
- Database provisioning: no auto-create (404); platform-API create 359–558ms,
  connectable ~0.5s after create.
- Server-side Hrana `BEGIN IMMEDIATE` CAS: exactly one winner, 20/20, ~150ms
  (`@libsql/client`) / ~190ms (`@tursodatabase/serverless`).

## Production-readiness review

An adversarial multi-agent review (2026-08-08; seven dimensions, each finding
independently re-verified before it counted) confirmed 12 defects — 2 critical
— all fixed in this release:

- **[critical, py]** AB-BA deadlock between connection eviction and request
  locking that could wedge an entire node once >64 origins were touched.
- **[critical, ts]** `resonate:origin` headers carrying full dotted ids routed
  requests to phantom databases; headers are now normalized via `originOf` and
  refused with 400 when they contradict the request's id.
- **[high]** `task.continue` added to the boundary-push set; settles of
  external promises and suspended-task wakes now force a push (the caller may
  hold no lease, so no boundary of theirs would ever upload).
- **[high, py]** A failed COMMIT now rolls back instead of permanently wedging
  the cached connection; bare statements, `pull()` and `push()` are serialized
  with open transactions; eviction no longer discards per-origin lock identity.
- **[high]** Schema upgrades carry the tenant timeout index across instead of
  dropping it (a dropped index permanently stranded quiescent workflows).
- **[high, ts]** `TursoNetwork` now defaults to `ConsoleLogger("warn")` — a
  broken sweeper is no longer silent — and `tursoSyncDriver` warns when
  `UV_THREADPOOL_SIZE` is too small to be safe.
- Heartbeats no longer upload every origin database per beat; connections are
  closed when schema migration fails mid-open.

## Known Issues

- **Cross-node CAS without sharding: open question.** The sync driver's
  embedded-replica CAS is measured unsound (simultaneous `task.acquire` races
  double-win 50/50), and the upstream `remoteWrites` flag is measured broken
  (`@tursodatabase/sync` 0.7.2). Server-side Hrana transactions measure sound
  (20/20 single-winner) but are not yet integrated as a driver. **Deploy
  sharded: one writer per workflow.**
- `unblock` does not cross nodes; unsharded fleets pay a slow-path latency
  penalty on cross-node completion (documented in `turso.md`).
- Detached (re-rooted) lineages (`ctx.detached`) are unsupported by design.
- On Node, set `UV_THREADPOOL_SIZE` ≥ concurrently open sync databases; the
  sync engine's blocking calls can otherwise exhaust libuv's threadpool.
  `close()` on a sync database can hang while a pull is in flight.
