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

* **A result computed on one node does not reach the node waiting for it.**
  This is the sharpest edge of in-process delivery, and it is measured, not
  theoretical. `resonate.run(...)` waits by registering a listener carrying the
  caller's *unicast* address. If the workflow is finished by a different node —
  which happens whenever a timer resumed it elsewhere — that node emits the
  `unblock` and delivers it to **itself**. The waiting node never sees it and
  falls back on its own slow path.

  Measured with two nodes and one workflow that migrates: the work is done at
  `+165ms`, and the caller learns about it at `+60004ms`. One node alone: 812ms
  for four workflows. Two nodes: 60 seconds. Correctness is unaffected — the
  results are right, nothing runs twice — but the latency is not usable.

  `execute` does not have this problem because a task's retry timer re-emits it
  and any node can pick it up. `unblock` has no equivalent: nothing re-emits it,
  and nothing routes it. Closing this needs either address-routed delivery (a
  shared queue again) or a waiter that polls the promise it is blocked on
  instead of waiting to be told.

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

`libsqlDriver` is **known broken** — a workflow driven through it stalls
part way with no error, even on a single node. It is kept only because a
`file:` libSQL database *is* multi-process capable where the Turso local driver
is not, which makes it the right shape for a same-machine fleet once the stall
is understood.


## Running more than one node

Nodes do not share a disk — each has its own directory, and they converge
through the remote. That is the arrangement `TursoSyncDriver` is for, and it
has never been run against a real remote, so the fleet story below is what is
*known*, not what is guaranteed.

**Protocol correctness under contention holds.** Three nodes, each with its own
network, racing on the same workflows with timer-driven migration between them:
all workflows completed with correct results, work spread across all three
nodes, **zero** durable steps executed by more than one node, and **zero**
disagreement between nodes on any result. The version fences do their job.

**Liveness does not.** See the `unblock` bullet above: a workflow finished by
one node does not notify the node waiting for it, so a fleet pays 60 seconds
where a single node pays milliseconds. This is the blocking issue for
multi-node use.

Two more things a fleet meets:

* **The tenant database is the fleet's one global write bottleneck.** Every
  origin publishes its timers there. `TursoStore.flush` skips the write when an
  origin's timers have not moved, which removes most of the traffic, but the
  bottleneck is structural.

* **Embedded-replica sync is not linearizable.** The protocol's version fences
  assume a linearizable store. Two nodes writing the same origin through
  separate replicas converge by row-level merge, which is not the same thing. A
  fleet that can have two nodes on one workflow at once should use the client's
  remote-writes mode, where writes are serialized by the remote.

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

## Concurrency (superseded — see above)

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
