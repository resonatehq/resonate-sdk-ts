# A Third Execution Model: Durable Execution for Effect-TS

## Status

Design record. The prototype this describes (five independent cleanroom implementations, plus five iterations of
hardening on one of them) was built and measured, and its working tree was then lost to container reclamation
before it was committed. This document is the design and the measurements, reconstructed from the session record.
It is not a description of code that currently exists in this repository. Where a claim was measured, it says so;
where it was reasoned, it says that instead.

## Highlight

This SDK already ships two execution engines against one protocol: workflows as generator functions, and workflows
as ordinary `async` functions. Effect-TS is a candidate third. It is interesting not because it is another syntax
for the same thing, but because it is the first candidate whose runtime has opinions of its own — structured
concurrency, an explicit error channel, fibers, scopes, interruption — and those opinions collide with durable
execution in instructive ways.

The central finding is that the collisions are resolvable, and that resolving them makes one of the model's
hardest invariants checkable by the type system rather than by discipline.

## Background: what a durable execution engine must preserve

An execution is a tree of durable promises. A root promise is dispatched to a worker as a task; the worker runs
the root function; each durable operation the function performs mints a child promise, synchronously, with an id
derived positionally from its parent (`root:1`, `root:2`, `root:1.1` — a `:` under the root and a `.` below it).
The id is the idempotency key for that step's side effect.

A worker's run of a task is an **attempt**. An attempt ends in exactly one of three ways: it **completes** (the root
function returned and every child it started has settled), it **suspends** (nothing local remains to do and at
least one remote promise is pending, so the worker hands the task back and asks to be woken), or it raises a
**platform failure** (a request to the server failed, so the attempt is abandoned and the task released for
someone else to pick up).

Replay is what makes this durable: a later attempt re-runs the same function from the top, mints the same ids in
the same order, and finds the already-settled children already settled, so their side effects are not repeated.
Three properties carry the whole design:

- **Ordinals must be deterministic.** Re-running mints identical ids, or a replay serves one step's cached result
  to a different step.
- **A suspend must never happen while local work is running.** If the engine suspends under a live function, that
  function's next durable operation never happens and the work is silently lost.
- **A side effect must be reachable only where it can be made idempotent.** An effect may run twice, but only
  between the effect and its acknowledged settle.

## The Effect mapping

### A durable reference is an Effect

`Durable<A, E>` extends `Effectable.Class`, so a durable reference *is* an `Effect<A, E | Canceled | TimedOut>`.
It composes with `Effect.all`, `forEach` and `either` with no adapters, which is most of why the model feels
native rather than bolted on.

Its `commit()` reads the current node from a `FiberRef` **at execution time**, not at construction. That is what
makes the park belong to whoever actually awaits the reference, including a fiber the user forked, rather than to
whoever created it.

### Starting and waiting are separate, and visibly so

`ctx.run(fn, args)` returns `Effect<Durable<A, E>>`. The outer `yield*` starts the operation — the create is in
flight, and the effect completes on the acknowledgement. The inner `yield*` waits for the value:

```ts
const ref = yield* ctx.run(child, [x])   // started; create acknowledged
const value = yield* ref                 // parked until it settles
```

The double `yield*` is ugly and it was kept deliberately. Durable operations are eager — the create goes out at
the call, not at the await — and the two-step form is the only place that eagerness is visible in the source.
Reviewers split on this, and one found a real cost: `Effect.forEach(items, i => ctx.act(...), {concurrency: 5})`
compiles, reads correctly, and bounds nothing, because the start effect completes at the acknowledgement. If the
two-step form is kept, a one-step helper should ship beside it.

### Node bodies are root fibers, not children of the parent fiber

This is the sharpest collision with Effect, and the one most likely to be got wrong.

Structured concurrency says a forked child is interrupted when its parent returns. Durable execution says the
opposite: a parent function may return while its children are still running, and the parent's own settle is
*held* until every child settles. Forking node bodies under the parent fiber would interrupt exactly the children
the engine is obliged to keep.

So each node's body is forked as a scope-owned root fiber (`runFork` into the attempt's `Scope`), from the
create-acknowledgement handler. Starting from the acknowledgement is also safer than forking from the parent
fiber after the ack: a user `race` over two starts would otherwise leave a created-pending child that never
begins, which stalls the parent's settle forever.

The cost is that `runFork` does not inherit what `fork` gives free. Without explicit propagation there is no
parent span (every node is a tracing root), no log annotations, no user `Scheduler` or `ConfigProvider`. A
production version should capture the parent's `FiberRefs` at the call and fork with them, and should accept a
`Runtime` so an application's layers apply.

### Ordinals under concurrency

The ordinal is taken synchronously inside `Effect.suspend`, on the executing fiber. Under
`Effect.all([...], { concurrency: "unbounded" })` the ordinals follow the order in which the forked fibers first
reach that suspend — which is deterministic for a given Effect build, and is why the dependency must be pinned.
A user who builds their own worker pool gets ordinals in completion order and a replay that serves item A the
result of item B. This is inherent to positional ids and should be documented as a constraint on the user, not
buried.

### Park is counted, never observed

`parked = started && !returned && durableAwaits > 0`, where `durableAwaits` counts references whose create has
been acknowledged *pending*. It is never inferred from the event loop going quiet, and never from a fiber being
suspended — a fiber suspends for a plain `Effect.sleep` too, and treating that as a park is precisely how an
engine suspends under live local work.

An earlier prototype inferred the park by inspecting the fiber runtime's internal queue. It was replaced by the
counter, which is both correct and public API. The replacement was the single most valuable change in the series.

### Interruption is teardown, never a signal

A failed request trips a breaker that closes the attempt. The breaker comes *first*: after it, no action may be
sent and no node's function may start, whatever was queued. Only then is the scope closed, interrupting whatever
is still running. Interruption is how the attempt is cleaned up after the decision, never how the decision is
communicated — if interruption were the signal, a user's `catchAllCause` would be able to observe and alter a
platform failure, which the model forbids.

Note the residual tension: in Effect, `try/finally` and every `ensuring`/`acquireRelease` release *does* run on
interruption, so user finalizers fire on every suspend as well as on every failure. An Effect user's instinct is
to write saga compensation with `acquireRelease`, which would compensate while merely waiting. Until there is a
sanctioned compensation primitive, this needs to be loud in the docs.

## `act`: making the leaf/workflow boundary a type

The model distinguishes a **workflow** (performs durable operations) from a **leaf** (performs side effects and no
durable operation). In the generator and async engines the distinction is behavioural, and the rule "a workflow
awaits only durable promises" is discipline.

`ctx.act(fn, args, { retry })` makes it structural. The leaf receives an **info object**, not a context:

```ts
info = { id, attempt, deadline }   // no run, act, rpc, sleep, promise, detached
```

A leaf therefore *cannot* mint a durable operation — there is nothing to call. Three consequences:

- The invariant becomes a compile error rather than a runtime hazard.
- Retry eligibility becomes static. A body that cannot perform a durable operation is always retryable, so the
  engine does not need to consult execution history at throw time.
- `info.id` is the step's id, which is exactly the idempotency key a side effect wants, and it is preserved if the
  leaf is later promoted to a workflow — the new workflow's `ctx.id` is the same `root:1` the leaf's `info.id`
  was. That migration property is the best thing in the design.

On the wire an `act` child is indistinguishable from a `run` child: zero protocol change, verified by comparing
full traces (189 nodes identical, 0 differing).

One honest limit, found by three independent reviewers: once a leaf is allowed to *return* an `Effect` (a
relaxation made for ergonomics — typed errors and inherited interruption), a `Durable` captured from an enclosing
scope can be awaited inside the leaf, which parks the leaf's own node. The type closes the shape of the leaf, not
what the leaf's Effect may touch. The guard that `op` already has (fiber ownership) belongs on the await path too.

## The mirror

Alongside the runtime the engine maintains a second model of the attempt — one node per promise minted — fed by
the same events and consulted only by assertions. A disagreement between the two is a defect in one of them.

Independence is only real where the mirror *derives* something the runtime does not hand it: ordinal contiguity,
the hold rule, the descendant walk behind a settle, and the completeness of the suspend set. `running`, `parked`
and `returned` can only be copied from events the runtime emits out of its own conclusions, so no disagreement
about a park — the one failure the model most needs to catch — is detectable there. The specification should say
which states must be re-derived and drop the claim of independence for the rest.

A mirror assertion must report and must never terminate the process. A default handler that rethrew from a timer
turned every assertion into an uncaught exception that killed the worker and every lease it held; the measured
corpus raises twenty to thirty of these per fault-injected run.

## Protocol facts, measured against a live server

Four points where the written protocol was ambiguous or wrong, settled by experiment rather than by choosing a
reading:

| question | answer |
|---|---|
| `task.fence` on an action naming the task's own promise | **400**, "Action ID must not equal the task ID" — so the root is never fenced; it settles through `task.fulfill` alone |
| `task.fence` preload | **non-empty** — it is the task's branch, and grows as children are created |
| `promise.create` on an existing id | **200** with the existing record, never 409 |
| `task.acquire` on a timer task | **200** while the timer is pending, **409** once it is due |

The last one has a cost worth stating: recognising a timer requires acquiring it first, so a pending timer task is
re-acquired on every re-dispatch — about one request per second per outstanding durable sleep. Putting a timer
flag in the execute message head would remove it.

Separately: `task.heartbeat` answers **200 unconditionally** — wrong pid, stale version, unknown task, lease
already stolen. A worker therefore cannot learn its lease is gone from the heartbeat; it learns at its next fence,
which answers 409 on a stale version. Any design that proposes to detect lease loss from the heartbeat response is
not implementable.

## Known gaps

Two are design gaps rather than defects, and both block real workflows:

- **No way to cancel or abandon a child.** `Effect.race`/`timeout` over a `Durable` drops only the waiter; the
  losing child stays pending, and an attempt cannot complete while any child is unsettled. So racing an external
  promise against a seven-day timer fulfils the root on day seven even if the answer arrives on day one.
- **Lazy deadlines need a durable timer.** The server flips a pending promise to timed-out only when the record is
  next read after its deadline. An SDK-side `setTimeout` on the worker that suspended is lost on restart, so a
  long human-approval timeout means "times out when someone next looks".

Together these are why a seven-day approval workflow cannot be written correctly today. The workaround — a daily
loop that races a one-day sleep, re-reading the external each day — works, and costs up to a day of latency.

Also open: defects are laundered into the typed failure channel (the wire could carry the distinction in a
header); a leaf gets no `AbortSignal`, so a Promise-returning leaf cannot observe interruption; and every request
needs a deadline, since a half-open connection otherwise wedges a task permanently with the lease renewed forever.

## Method note

The prototype was produced by cleanroom generation — independent agents implementing from the specification alone,
never reading each other — which is what made convergence and divergence measurable. Conformance was judged by a
tree checker that replays an event log and asserts the legality of every transition, plus whole-tree invariants.

The most transferable lesson is not about the SDK. Across the exercise, eight separate occasions arose where a
checker reported "nothing wrong" when it should have reported "I cannot tell": a summary that read only one of two
available verdicts; a classifier keyed to one implementation's phrasing; a harness that installed its own handler
and so masked a defect the SDK was reporting about itself; a run whose conformance leg produced an empty log and
graded clean; a leg that suppressed the wire events half its rules depended on; a driver whose denominator was
computed from whatever ran rather than from what should have run. Every one of them made the system look better
than it was. A checker that cannot distinguish "clean" from "I did not look" is worse than no checker, because it
is believed.
