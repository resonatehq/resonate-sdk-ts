# Decentralized Resonate on Turso

`TursoNetwork` is a `Network` with no server behind it.

Every other network in this SDK is a transport: it carries a request to a
Resonate Server and carries the response back. This one is not. The SDK *is*
the server — it carries the protocol's transition relation and runs it locally
against Turso databases it reads, writes, and syncs directly.

```ts
import { Resonate } from "@resonatehq/sdk";
import { TursoNetwork, tursoSyncDriver } from "@resonatehq/sdk/turso";

const resonate = Resonate.remote({
  network: new TursoNetwork({
    driver: tursoSyncDriver({
      dir: "/var/lib/resonate",
      url: "libsql://acme-",          // remote database is `acme-<origin>`
      authToken: process.env.TURSO_AUTH_TOKEN,
    }),
    prefix: "acme-",                  // local database is `acme-<origin>`
    timeoutDatabase: "timeouts",      // tenant-global: `acme-timeouts`
    group: "default",
  }),
});
```

## One database per workflow

Every promise id is prefixed by its **origin** — the root workflow's id,
everything before the first `.`. `TursoNetwork` gives each origin its own
database, named `<prefix><origin>`.

That is not an arbitrary sharding key. The protocol already guarantees a
callback never crosses an origin (`promise.register_callback` refuses one, and
the Resonate Server enforces the same rule), so every request touches exactly
one workflow's state — which makes every request a single-database
transaction. A workflow is a unit of consistency, and here it becomes a unit of
storage too. That is what makes each database small enough for a process to
hold as an embedded replica.

An origin database holds everything about one workflow: its promises, the
callbacks and listeners registered against them, its tasks, and the armed
timeouts.

## One tenant-global timeout database

`<prefix><timeoutDatabase>` (default `<prefix>timeouts`) holds what no single
workflow owns:

| Table | Purpose |
|-------|---------|
| `timeouts` | `(origin, id, kind, timeout_at)` — the index of armed timers across every origin, so a sweeper can find due work without opening every workflow |
| `schedules` | schedules, which are tenant-scoped by definition — a schedule's promise id is a template, so the promises it fires belong to many origins |

The timeout table is a **mirror, never the authority**. The origin database
holds the armed timers; `TursoStore.flush` republishes the origin's slice after
every commit. Nothing trusts the index: every timeout transition re-reads its
own armed time from the origin database and refuses an early firing (the spec's
NOT BEFORE rule), so a stale entry costs a wasted database open and nothing
else. A *missing* entry only delays work — the origin still holds the truth,
and the next flush restores it.

## Messages are not stored

When a transition emits an `execute` or `unblock`, the message is handed to the
local Resonate client as soon as the transaction commits. No outbox, no queue,
no routing table. Delivery is deferred by one turn of the event loop so the
response reaches the caller first and a subscriber cannot re-enter the call
that produced its message — the same ordering `LocalNetwork` gives.

Reaching a **different** process therefore goes through time, not through a
queue. A dispatched task carries a durable retry timer; if nobody claims it,
the timer comes due, and whichever process sweeps the tenant timeout index
re-emits the execute and delivers it to its own client. Recovery is the timer —
which is exactly why the timeout database is the one thing shared.

Three consequences worth knowing:

* **`resonate:target` is advisory.** The address is recorded on the promise and
  echoed in the message, but nothing routes by it: a message goes to whoever
  did the work. In a homogeneous fleet — every process registering the same
  functions — that is what you want. In a heterogeneous one, where only some
  processes can run a given function, this network will not deliver work to the
  right group.

* **An `execute` survives a crash; an `unblock` may not.** If a process dies
  between the commit and the delivery, the task's retry timer re-emits the
  execute. Nothing re-emits an `unblock`, so a listener waiting on a promise
  that settled in the lost window will not be woken by this network.

* **First dispatch is local.** Creating a targeted promise hands the execute to
  the creating process. If that process is a client that cannot run the
  function, the task simply stays pending until its retry timer hands it to a
  sweeper that can.

## Drivers

A driver maps a logical database name to physical storage. Three ship:

| Driver | Package | Use |
|--------|---------|-----|
| `tursoSyncDriver` | `@tursodatabase/sync` | embedded replica per workflow, syncing with Turso Cloud — the decentralized arrangement |
| `tursoLocalDriver` | `@tursodatabase/database` | a local directory of databases, or `:memory:` |
| `libsqlDriver` | `@libsql/client` | deployments already standardized on libSQL |

All three are optional peer dependencies, imported dynamically. Implement
`TursoDriver` for anything else — it has one method, `open(name)`.

## What the schema follows

The schema and transitions follow
[`resonatehq/resonate-specification`](https://github.com/resonatehq/resonate-specification)
(`spec/03-concrete`), not the SQL in `resonatehq/resonate`'s
`persistence_sqlite.rs`. The two have diverged; where they do, the spec wins.
The differences that show up here:

* **Projection, not mutation.** A pending promise past its deadline is
  *logically* settled, and nothing mutates state to discover that. Every guard
  and every response consults the projected view; only the timeout transition
  converges the stored row. This is why a read is side-effect free — and so why
  a replica can serve one without pushing.

* **`external` gates durable timeouts**, not `resonate:target`. A promise is
  external when it is tagged `resonate:external`, carries a `resonate:target`,
  or is a timer. Only external promises may be awaited (`register_callback` and
  `register_listener` answer `422` otherwise) and only they arm a durable
  timeout.

* **`resonate:delay` defers the first dispatch.** A targeted promise created
  with a delay still ahead of `now` arms its retry timer at the delay and emits
  no execute message; the timer's first firing is the first dispatch.

* **Timeout always wins.** Retry and lease timers consult the projected promise
  before acting, so a logically dead task is neither redispatched nor returned
  to circulation.

* **Deferred resumes.** Settlement records a resume obligation per awaiter
  rather than resuming inline, and the drain runs in the same transaction — a
  suspended task has no armed timer, so a lost resume would strand it forever.

Turso does not support generated columns without an experimental flag, so the
tag-derived columns (`target`, `branch`, `timer`, `external`) are written by the
SDK rather than computed by the engine. This schema is therefore **not** the
Resonate Server's SQLite schema and the two are not interchangeable.

## What is not supported

* **Tenant-wide `promise.search` / `task.search`** answer `501`. Promises are
  partitioned across one database per origin, so "every promise" is not a query
  any single database can answer. Narrow the search with a `resonate:origin`
  tag (or the `resonate:origin` request header) and it is served from that
  workflow's database.

* **Tenant-wide `debug.snap`** answers `501` for the same reason; set the
  `resonate:origin` header to snapshot one workflow.

* **`http://` listener addresses.** An `unblock` for one is emitted and handed
  to the local client like any other message, but nothing makes the HTTP call —
  there is no server to make it. Treat these as unsupported.

## Concurrency

A task lease already gives a workflow one writer at a time, which is the
arrangement this design is built for. Within a process, requests against an
origin are serialized. Across processes writing the same origin concurrently
through embedded replicas, the sync engine resolves at the row level and the
protocol's version fences reject the loser's stale writes — but a caller who
needs strict linearizability across concurrent writers to one workflow should
enable the client's remote-writes mode.

## Tests

```shell
npm run test:turso
```

The Turso client packages are ESM-only and need `--experimental-vm-modules`,
which changes Jest's semantics for the rest of the suite, so these tests run
under their own config (`jest.turso.config.cjs`). `npm test` runs both.
