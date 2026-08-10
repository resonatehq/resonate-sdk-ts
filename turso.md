# Decentralized Resonate on Turso

`TursoNetwork` is a `Network` with no server behind it.

## Production readiness (reviewed 2026-08-08)

An adversarial review — seven independent dimensions over both SDKs, every
finding re-verified against the code by a refuter before it counted — preceded
this release. Twelve findings were confirmed (two critical); all are fixed on
this branch, with regression tests for the criticals. Status by concern:

| Concern | Status |
|---|---|
| Single-node correctness (full suites, both engines) | ✅ tested |
| Sharded fleet — one owner per workflow | ✅ measured, locally and through Turso Cloud |
| Convergence through Turso Cloud (timer visibility ~200ms, cross-node pickup, crash recovery) | ✅ measured |
| Turso Cloud provisioning (no auto-create; API create ~384ms; region-qualified hostnames) | ✅ measured |
| Boundary uploads (`pushOn: "boundary"`) | ✅ implemented, reviewed, tested |
| Origin routing (`resonate:origin` header normalized and validated) | ✅ fixed under review, regression-tested |
| **Cross-node CAS without sharding** | ⚠️ **answered, not yet shipped** — a guard trigger makes the push a real CAS (measured 20/20 single-winner unsharded, through the protocol); needs server-side provisioning, a replica-reset path, and a push per write. Static sharding remains the shipped recommendation. |
| Detached (re-rooted) lineages — `ctx.detached` | ✖ unsupported by design (see below) |

Deployment checklist:

* **Shard the fleet** (`shard`, route with `ownerOf`). One writer per workflow
  is the correctness boundary until the CAS question closes.
* **Set `UV_THREADPOOL_SIZE`** to at least the number of concurrently open
  sync databases; `tursoSyncDriver` warns at construction when it looks low.
* **Create databases before first connect** — Turso Cloud does not auto-create;
  pre-create via the platform API or wrap the driver with create-on-open.
* Failures are reported through a default `ConsoleLogger("warn")`; pass your
  own `Logger` to integrate with your logging stack.
* Group tokens expire; `authToken` accepts an async function for short-lived
  token minting.

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
      // A Turso Cloud database lives at `<name>-<org>.<region>.turso.io`,
      // so the flat prefix form cannot address it — pass a function.
      url: (name) => `libsql://${name}-acme.aws-us-west-2.turso.io`,
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

  **Static sharding avoids it** — see below. If every workflow has one owner and
  callers are routed to that owner, the node that finishes a workflow is the node
  that was waiting on it, and the message never has to cross a process.

* **First dispatch is local.** Creating a targeted promise hands the execute to
  the creating process. If that process is a client that cannot run the
  function, the task simply stays pending until its retry timer hands it to a
  sweeper that can.

## Turso Cloud provisioning (measured)

"One database per workflow" meets Turso Cloud on these terms, all measured
against a real account (`aws-us-west-2`, free plan, August 2026):

* **Databases are not auto-created.** A sync connect to a name that does not
  exist fails with `status=404, body=Host not found`. Every origin database —
  and the tenant database — must exist before `tursoSyncDriver` can open it,
  created via the platform API (`POST /v1/organizations/<org>/databases`) or
  the `turso` CLI.
* **Creation is cheap and immediate.** API creation took 359–558ms per
  database (median 384ms over 16 creates), and a fresh database accepted a
  sync connect 528ms after the create call, first attempt. A create-if-missing
  hook fits inside the driver's function-form `url` (or use Turso's
  `@tursodatabase/sdk-experimental`, whose `resolve()` provisions on first
  use), at the price of ~400ms and one platform round trip on a workflow's
  first touch.
* **The hostname is not `<prefix><origin>`.** A database lives at
  `<name>-<org>.<region>.turso.io` (the region-less `<name>-<org>.turso.io`
  form also works, but takes seconds to become resolvable after creation).
  A flat string prefix cannot produce that shape, so a Turso Cloud deployment
  must pass the function form:

  ```ts
  tursoSyncDriver({
    dir,
    url: (name) => `libsql://${name}-${org}.${region}.turso.io`,
    authToken,
  })
  ```

* **Plan limits are the real constraint, not mechanics.** The free plan caps
  an organization at 100 databases; paid plans advertise unlimited databases
  and meter storage, rows, and sync traffic instead. Sync traffic is the axis
  this design leans on — every replica bootstrap, push, and pull counts — so
  a busy fleet should assume the sync allowance, not the database count, is
  what it exhausts first.

For a deployment where per-workflow creation is unacceptable, the fallbacks
remain what they were: a pool of N pre-created databases with origins hashed
into them (`hashOrigin` is exported for exactly this), or one database per
tenant with an `origin` column — each giving up some of the isolation that
makes per-workflow CAS cheap.

## Drivers

A driver maps a logical database name to physical storage. Three ship:

| Driver | Package | Use |
|--------|---------|-----|
| `tursoSyncDriver` | `@tursodatabase/sync` | embedded replica per workflow, syncing with Turso Cloud — the decentralized arrangement |
| `tursoLocalDriver` | `@tursodatabase/database` | a local directory of databases, or `:memory:` |
| `libsqlDriver` | `@libsql/client` | deployments already standardized on libSQL |

All three are optional peer dependencies, imported dynamically. Implement
`TursoDriver` for anything else — it has one method, `open(name)`.

The three differ in what they can share, and that is usually what picks one:

* `tursoLocalDriver` takes an **exclusive file lock** on open. A second process
  opening the same file fails outright with `File is locked by another process`.
  It is a single-process driver — right for a node's own origin databases, wrong
  for anything the fleet shares.
* `libsqlDriver` with a `file:` URL uses ordinary SQLite locking, so several
  processes on one machine really do share a database. (It was previously
  documented here as broken; the actual fault was in this SDK — see
  `libsqlDriver` in `driver.ts` — and is fixed.)
* `tursoSyncDriver` shares through a remote, which is the only option across
  machines.

Origins and the tenant database need not use the same driver. `timeoutDriver`
opens the tenant database when it lives elsewhere:

```ts
new TursoNetwork({
  driver: tursoLocalDriver({ dir: "/var/lib/resonate/node-0" }),  // mine alone
  timeoutDriver: libsqlDriver({ url: "file:/var/lib/resonate/shared/" }),
})
```

## Sharding a fleet

`shard: { index, count }` gives a node a fixed slice of the workflows:

```ts
new TursoNetwork({ driver, shard: { index: 0, count: 2 } })
```

The node then sweeps only timers whose origin it owns —
`hashOrigin(origin) % count === index` — filtered in SQL against the shared
index, not in memory after reading everyone's.

This turns "any node may pick up any workflow" into "every workflow has exactly
one owner", which buys three things: a workflow stops migrating mid-flight, one
owner means one writer (which is what the CAS fences want), and the `unblock`
problem below stops mattering, because the node that finishes a workflow is the
node that was waiting on it.

**Every node must be started with the same `count`.** Ownership is
`hashOrigin(origin) % count`, so a node using a different one leaves some
workflows owned by nobody (their timers stay due, and nothing logs) and others
owned by two. Nothing enforces this — the count comes from your deployment
config, and resizing means stopping the fleet and starting it again with the
new `count` everywhere. Note that a resize also *moves* workflows between
nodes, so origin databases must be shared (or reachable) rather than
node-local, or a workflow resurfaces on a node holding no copy of it.

The caller must route requests to the owning node using the same function —
`ownerOf(originOf(id), count)`, exported for exactly this. The hash lives in the
SDK rather than in the caller so that routing and sweeping cannot disagree; the
Python SDK's `hash_origin` computes the same values, and both suites pin the
same vector.

`examples/turso-fleet/node.ts` is a runnable two-node fleet: an HTTP front door
with `/invoke` and `/get`, per-node origin storage, a shared timer index, and
forwarding for workflows a node does not own.

## Running more than one node

Nodes do not share a disk for their origins — each has its own directory. What
they must share is the timer index, since that is the one place a node learns
that work exists at all.

**Convergence through a real remote works — measured.** Two nodes, separate
replica directories, one Turso Cloud remote (`aws-us-west-2`, ~100ms push RTT
from the test machine), tick 100ms:

* **Timer visibility lag** — a committed write is visible to another replica's
  pull in **~190–220ms median** (n=30 across three runs; p90 270–400ms, worst
  observed 1.1s). The push itself is ~100ms of that. This bounds how fast the
  fleet can learn that work exists.
* **Cross-node pickup end to end** — a workflow parked on a 4s durable sleep
  by node 0, which then stopped: node 1 discovered it through the tenant
  index, resumed it, and completed it at **+5985ms total (~2s overhead over
  the sleep**, of which ~1.1s was the initial `beginRun` round trips and
  ~0.9s the sweep-and-resume itself).
* **Crash recovery across process generations** — workflows abandoned by
  earlier killed processes were picked up by later, unrelated nodes off their
  stale timers in the shared index and completed correctly.
* **Index integrity at quiescence** — after all of the above (two nodes
  rewriting four origins' slices, including the multi-writer flushes the
  `published` fingerprint cache was suspected to mishandle), the tenant index
  exactly matched the union of origin databases: no missing entries, no stale
  entries. The suspected stale-skip did not produce divergence.

**Protocol correctness under contention holds.** Three nodes, each with its own
network, racing on the same workflows with timer-driven migration between them:
all workflows completed with correct results, work spread across all three
nodes, **zero** durable steps executed by more than one node, and **zero**
disagreement between nodes on any result. The version fences do their job.

**Sharded, a fleet works end to end.** Two nodes, `shard 0/2` and `shard 1/2`,
each with its own origin directory and both on one `file:` timer index: six
workflows submitted entirely to node 0, three forwarded to node 1 by hash, every
one parked on a durable 8-second sleep and resumed by its owner, no warnings.
Each node fired exactly its own six timers out of the twelve in the shared
table.

**Unsharded, liveness does not hold.** See the `unblock` bullet above: a
workflow finished by one node does not notify the node waiting for it, so a
fleet pays 60 seconds where a single node pays milliseconds. Static sharding
sidesteps it rather than fixing it — the owner is the waiter — so a fleet that
rebalances or steals work still meets it.

Two more things a fleet meets:

* **The tenant database is the fleet's one global write bottleneck.** Every
  origin publishes its timers there. `TursoStore.flush` skips the write when an
  origin's timers have not moved, which removes most of the traffic, but the
  bottleneck is structural.

* **Compare-and-swap does not survive replication — measured, and worse than
  feared.** Every fenced action (`task.acquire` and friends) is a
  read-compare-write inside a single `BEGIN IMMEDIATE` transaction. That is a
  genuine CAS — against the one database that applies it. Across nodes it is
  not a CAS at all:

  * **Default (local writes):** two nodes racing `task.acquire` for the same
    `{id, version: 0}` through the same Turso Cloud remote both won **50 times
    out of 50** (~250ms per acquire). Not "may both win" — with each CAS
    applied to its own replica there is nothing to contend with, so a
    simultaneous race *always* double-wins.

  * **`remoteWrites: true` does not fix it:** both nodes still won **50 out of
    50**, now at 11–13 seconds per acquire. A follow-up probe shows why: both
    nodes returned `200` with `version 1, acquired`, while an independent
    fresh replica read the remote as still `version 0, pending, pid null` —
    under `@tursodatabase/sync` 0.7.2 the remote-writes path neither
    serializes the transaction remotely nor even lands its writes. The
    previous revision of this document recommended the flag; that
    recommendation was wrong and is withdrawn. Do not use `remoteWrites`.

  **A guard trigger makes the push itself the compare-and-swap — measured.**
  The mechanism (from the Turso team) is a version row whose trigger rejects
  any update that is not exactly +1:

  ```sql
  CREATE TABLE cas_table (key TEXT PRIMARY KEY, value);
  CREATE TRIGGER cas_table_conflict
  BEFORE UPDATE ON cas_table
  WHEN CAST(NEW.value AS INTEGER) != CAST(OLD.value AS INTEGER) + 1
  BEGIN SELECT RAISE(ROLLBACK, 'unexpected existing row state'); END;
  ```

  A writer bumps the row inside its transaction and pushes. The remote applies
  pushes one at a time, so a node that staked version *v+1* while another
  already landed it trips the trigger, and the push is rejected with
  `SQLITE_CONSTRAINT`. That converts the replica's local commit into a
  *proposal* and makes the push the real commit point.

  It holds end to end. Two `TursoNetwork` nodes, separate replicas, one
  remote, **no sharding**, racing `task.acquire` for the same
  `{id, version: 0}` — the arrangement measured at 50/50 double wins — give
  **exactly one winner, 20 times out of 20**, at ~1.1s per winning acquire
  (`experiments/exp-e.ts`). The rejection is atomic over the whole push: the
  loser's other writes do not land either.

  Three things to know before building on it:

  * **The trigger must be installed server-side**, at provisioning time, over
    Hrana or the CLI. DDL pushed from a replica does *not* register a trigger
    on the remote — `sqlite_master` there comes back with no triggers at all,
    and the guard then silently does nothing (which is exactly how the first
    run of this experiment produced 8/8 double wins). `TursoStore.migrate`
    runs its DDL through the driver, so it cannot install this.
  * **A rejected push wedges the replica.** It still holds the rejected
    change, and every later `pull` fails with `failed to replay local change
    after remote apply`; retrying does not clear it and neither does
    `checkpoint()`. The client exposes no revert. The only way back is to
    close the database, delete its local files, and re-bootstrap — ~420ms for
    a small database, after which the node works normally.
  * **It costs a remote round trip per write.** The fence is only sound if the
    push happens with the fenced action, so guarded mode and `pushOn:
    "boundary"` are in tension: batching uploads to task boundaries delays
    arbitration past the point where user code has already run.

  So there are now two sound arrangements, and they trade the same thing in
  opposite directions. **Static sharding** keeps writes at local-disk latency
  and pays for it with a fixed owner per workflow. **A guard trigger** lets any
  node write any workflow and pays a round trip per write. Sharding remains
  the default recommendation; the guard is what makes work-stealing, rebalancing,
  and unsharded fleets possible at all.

  **A sound CAS does exist one driver over — measured.** The same Turso Cloud
  database also serves Hrana v3, the server-side transaction protocol, and a
  `BEGIN IMMEDIATE` read-compare-write raced from two clients there yields
  **exactly one winner, 20/20**, with the loser observing the winner's write —
  via `@libsql/client` `transaction("write")` (median 150ms per winning
  acquire) and equally via `@tursodatabase/serverless` sessions (median
  190ms; Hrana pipeline with batons, plain `fetch`, no native code). See
  `experiments/exp-c.ts`. Two consequences:

  * Zero new code today: point `libsqlDriver` at the same hostnames
    (`url: (name) => \`libsql://${name}-<org>.<region>.turso.io\``) and every
    origin transaction is server-side and linearizable — a fleet is sound in
    any topology, no sharding required, at ~150ms per transition instead of
    local-disk latency. Sharding becomes a latency optimization rather than a
    correctness requirement.
  * The replica-first design can keep its local reads and gain a sound fence
    by routing writes — at minimum the fenced transitions — through a
    server-side transaction and never pushing from replicas (pull-only), so
    the WAL-merge path that breaks the fence is never exercised. That is
    "remote writes" done right, and it is buildable against what Turso Cloud
    serves today.

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

* **Schedules.** `schedule.create`, `schedule.get`, `schedule.search` and
  `schedule.delete` answer 501. They are the one tenant-scoped part of the
  protocol, and rather than half-implement them they are left out; a database
  created by an older build may still carry an unused `schedules` table.

* **`http://` listener addresses.** An `unblock` for one is emitted and handed
  to the local client like any other message, but nothing makes the HTTP call —
  there is no server to make it. Treat these as unsupported.

* **Detached (re-rooted) lineages.** `ctx.detached` creates a child whose
  `resonate:origin` tag is its own dotted id, re-rooting the lineage. The
  origin partition cannot represent a root whose id contains `.` — database
  selection is `originOf(id)`, which would split the detached workflow and its
  children across databases — so `promise.create` refuses the tag with a 400
  naming this limitation. Start detached work as a genuine root instead
  (`beginRun` with a fresh un-dotted id).

## When the cloud is written: `pushOn`

A task lease gives a workflow one writer for the span of a tenure, which makes
per-request uploads mostly wasted motion: nobody else may read the workflow's
intermediate steps before the tenure ends. `pushOn` on `TursoNetwork` makes
that explicit:

* `"boundary"` (default) — writes stay on the local replica until a moment
  another process could ever need to read from: the task fulfills, suspends,
  releases, or halts; work becomes visible to the fleet (`task.create`, a root
  or targeted `promise.create`); or the root promise settles. Sweep-driven
  recovery transitions always push. The trade is recovery granularity: a node
  that crashes mid-tenure is recovered from its last boundary, and the durable
  steps since then are re-executed — at-least-once per tenure segment instead
  of per step.

* `"request"` — the old behavior: push after every committed write. Recovery
  loses at most one request; the cloud sees every durable step as it lands.

A timer index entry may briefly advertise state the remote cannot serve yet
(the entry is published before the boundary push). That is safe by the same
rule that makes every index entry safe: a consumer re-validates against the
origin database and treats "not armed yet" like any stale entry — it costs a
wasted open per sweep until the boundary push lands, and nothing else.

## Turso Cloud operational gotchas (all paid for)

* **Set `UV_THREADPOOL_SIZE`.** The sync engine's blocking native calls run on
  libuv's threadpool, which defaults to 4 threads. A process holding several
  sync databases — one tenant index plus a few origins is already enough —
  can park all four slots in long-poll pulls and pushes, at which point the
  entire process freezes: every pending operation waits for a slot that will
  never free. Observed twice as a total wedge (all replicas' files untouched
  for minutes, every timer silent); `UV_THREADPOOL_SIZE=64` resolved it.
  Budget roughly one slot per concurrently-open sync database.

* **`close()` on a sync database can hang** when a pull is in flight, which
  makes `network.stop()` (and so `resonate.stop()`) hang with it. `stop()`
  marks the network stopped and clears the tick timer *before* it closes
  connections, so the node is already inert when the hang happens — a caller
  that needs to exit promptly should race `stop()` against a timeout.

* **A swept origin can lose its connection mid-fire** (`database must be
  connected` in a `turso timeout sweep failed` warning) when the store evicts
  it. The sweep retries next tick and the fleet self-heals; the warning is
  noise unless it repeats for the same origin indefinitely.

* **A database name reaches a URL.** An origin comes verbatim from a
  caller-supplied promise id, and the protocol only forbids `.` there. The
  URL-addressed drivers reject names carrying URL delimiters rather than
  escaping them (`libsql://acme-` + `jobs/admin` would otherwise address
  `acme-jobs`, a different database entirely). If workflow ids come from
  untrusted input, expect `Invalid database name for a URL-addressed driver`
  and constrain the ids upstream.

* **The store does not reopen after `stop()`.** Requests arriving after a stop
  fail with `TursoStore is closed` rather than silently reopening databases
  nothing will ever close. Build a new `TursoNetwork` to restart.

## Tests

```shell
npm run test:turso
```

The Turso client packages are ESM-only and need `--experimental-vm-modules`,
which changes Jest's semantics for the rest of the suite, so these tests run
under their own config (`jest.turso.config.cjs`). `npm test` runs both.
