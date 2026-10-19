# A Third Execution Model: Durable Execution for Effect-TS

## Status

Design record. The prototype this describes (five independent cleanroom implementations, plus five iterations of
hardening on one of them) was built and measured, and its working tree was then lost to container reclamation
before it was committed. This document is the design and the measurements, reconstructed from the session record.
**It is not a description of code that currently exists in this repository.** Where a claim was measured, it says
so; where it was reasoned, it says that instead.

## Highlight

This SDK ships two execution engines against one protocol: workflows as generator functions, workflows as ordinary
`async` functions. Effect-TS is candidate third. Interesting not because it is another syntax for same thing, but
because it is first candidate whose runtime has opinions of its own — structured concurrency, explicit error
channel, fibers, scopes, interruption. Those opinions collide with durable execution in instructive ways.

Central finding: collisions are resolvable. Resolving them makes one of model's hardest invariants checkable by
type system rather than by discipline.

## Background: what a durable execution engine must preserve

Execution is tree of durable promises. Root promise is dispatched to worker as task. Worker runs root function.
Each durable operation the function performs mints child promise, synchronously, with id derived positionally from
its parent (`root:1`, `root:2`, `root:1.1` — `:` under root, `.` below it). Id is idempotency key for that step's
side effect.

Worker's run of task is **attempt**. Attempt ends in exactly one of three ways. It **completes**: root function
returned and every child it started has settled. It **suspends**: nothing local remains to do and at least one
remote promise is pending, so worker hands task back and asks to be woken. It raises **platform failure**: request
to server failed, so attempt is abandoned and task released for someone else to pick up.

Replay makes this durable. Later attempt re-runs same function from top, mints same ids in same order, finds
already-settled children already settled, so their side effects are not repeated. Three properties carry whole
design:

- **Ordinals must be deterministic.** Re-running mints identical ids, or replay serves one step's cached result to
  different step.
- **Suspend must never happen while local work is running.** If engine suspends under live function, that
  function's next durable operation never happens and work is silently lost.
- **Side effect must be reachable only where it can be made idempotent.** Effect may run twice, but only between
  effect and its acknowledged settle.

## The Effect mapping

### A durable reference is an Effect

`Durable<A, E>` extends `Effectable.Class`, so durable reference *is* `Effect<A, E | Canceled | TimedOut>`. It
composes with `Effect.all`, `forEach` and `either` with no adapters. That is most of why model feels native rather
than bolted on.

Its `commit()` reads current node from `FiberRef` **at execution time**, not at construction. That makes park
belong to whoever actually awaits reference, including fiber user forked, rather than to whoever created it.

### Starting and waiting are separate, and visibly so

`ctx.run(fn, args)` returns `Effect<Durable<A, E>>`. Outer `yield*` starts operation: create is in flight, effect
completes on acknowledgement. Inner `yield*` waits for value:

```ts
const ref = yield* ctx.run(child, [x])   // started; create acknowledged
const value = yield* ref                 // parked until it settles
```

Double `yield*` is ugly. Kept deliberately. Durable operations are eager — create goes out at call, not at await —
and two-step form is only place that eagerness is visible in source. Reviewers split on this, and one found real
cost: `Effect.forEach(items, i => ctx.act(...), {concurrency: 5})` compiles, reads correctly, and bounds nothing,
because start effect completes at acknowledgement. If two-step form is kept, one-step helper should ship beside
it.

### Node bodies are root fibers, not children of the parent fiber

Sharpest collision with Effect. Most likely to be got wrong.

Structured concurrency says forked child is interrupted when its parent returns. Durable execution says opposite:
parent function may return while its children are still running, and parent's own settle is *held* until every
child settles. Forking node bodies under parent fiber would interrupt exactly the children engine is obliged to
keep.

So each node's body is forked as scope-owned root fiber (`runFork` into attempt's `Scope`), from
create-acknowledgement handler. Starting from acknowledgement is also safer than forking from parent fiber after
ack: user `race` over two starts would otherwise leave created-pending child that never begins, which stalls
parent's settle forever.

Cost: `runFork` does not inherit what `fork` gives free. Without explicit propagation there is no parent span
(every node is tracing root), no log annotations, no user `Scheduler` or `ConfigProvider`. Production version
should capture parent's `FiberRefs` at call and fork with them, and should accept `Runtime` so application's layers
apply.

### Ordinals under concurrency

Ordinal is taken synchronously inside `Effect.suspend`, on executing fiber. Under
`Effect.all([...], { concurrency: "unbounded" })` ordinals follow order in which forked fibers first reach that
suspend — deterministic for given Effect build, and that is why dependency must be pinned. User who builds own
worker pool gets ordinals in completion order and replay that serves item A result of item B. This is inherent to
positional ids. Document as constraint on user, do not bury.

### Park is counted, never observed

`parked = started && !returned && durableAwaits > 0`, where `durableAwaits` counts references whose create has
been acknowledged *pending*. Never inferred from event loop going quiet. Never from fiber being suspended — fiber
suspends for plain `Effect.sleep` too, and treating that as park is precisely how engine suspends under live local
work.

Earlier prototype inferred park by inspecting fiber runtime's internal queue. Counter replaced it. Counter is both
correct and public API. Replacement was single most valuable change in series.

### Interruption is teardown, never a signal

Failed request trips breaker that closes attempt. Breaker comes *first*: after it, no action may be sent and no
node's function may start, whatever was queued. Only then is scope closed, interrupting whatever is still running.
Interruption cleans up attempt after decision. Interruption never communicates decision — if interruption were
signal, user's `catchAllCause` could observe and alter platform failure, which model forbids.

Note residual tension: in Effect, `try/finally` and every `ensuring`/`acquireRelease` release *does* run on
interruption, so user finalizers fire on every suspend as well as on every failure. Effect user's instinct is to
write saga compensation with `acquireRelease`, which would compensate while merely waiting. Until there is
sanctioned compensation primitive, this needs to be loud in docs.

## `act`: making the leaf/workflow boundary a type

Model distinguishes **workflow** (performs durable operations) from **leaf** (performs side effects and no durable
operation). In generator and async engines distinction is behavioural, and rule "a workflow awaits only durable
promises" is discipline.

`ctx.act(fn, args, { retry })` makes it structural. Leaf receives **info object**, not context:

```ts
info = { id, attempt, deadline }   // no run, act, rpc, sleep, promise, detached
```

Leaf therefore *cannot* mint durable operation — nothing to call. Three consequences:

- Invariant becomes compile error rather than runtime hazard.
- Retry eligibility becomes static. Body that cannot perform durable operation is always retryable, so engine does
  not need to consult execution history at throw time.
- `info.id` is step's id, which is exactly idempotency key side effect wants, and it is preserved if leaf is later
  promoted to workflow — new workflow's `ctx.id` is same `root:1` leaf's `info.id` was. That migration property is
  best thing in design.

On wire, `act` child is indistinguishable from `run` child: zero protocol change, verified by comparing full
traces (189 nodes identical, 0 differing).

One honest limit, found by three independent reviewers: once leaf is allowed to *return* `Effect` (relaxation made
for ergonomics — typed errors and inherited interruption), `Durable` captured from enclosing scope can be awaited
inside leaf, which parks leaf's own node. Type closes shape of leaf, not what leaf's Effect may touch. Guard that
`op` already has (fiber ownership) belongs on await path too.

## The mirror

Alongside runtime, engine maintains second model of attempt — one node per promise minted — fed by same events and
consulted only by assertions. Disagreement between the two is defect in one of them.

Independence is only real where mirror *derives* something runtime does not hand it: ordinal contiguity, hold
rule, descendant walk behind settle, completeness of suspend set. `running`, `parked` and `returned` can only be
copied from events runtime emits out of its own conclusions, so no disagreement about park — the one failure model
most needs to catch — is detectable there. Specification should say which states must be re-derived and drop claim
of independence for rest.

Mirror assertion must report. Mirror assertion must never terminate process. Default handler that rethrew from
timer turned every assertion into uncaught exception that killed worker and every lease it held. Measured corpus
raises twenty to thirty of these per fault-injected run.

## Protocol facts, measured against a live server

Four points where written protocol was ambiguous or wrong, settled by experiment rather than by choosing reading:

| question | answer |
|---|---|
| `task.fence` on action naming task's own promise | **400**, "Action ID must not equal the task ID" — root is never fenced; it settles through `task.fulfill` alone |
| `task.fence` preload | **non-empty** — it is task's branch, and grows as children are created |
| `promise.create` on existing id | **200** with existing record, never 409 |
| `task.acquire` on timer task | **200** while timer is pending, **409** once it is due |

Last one has cost worth stating: recognising timer requires acquiring it first, so pending timer task is
re-acquired on every re-dispatch — about one request per second per outstanding durable sleep. Timer flag in
execute message head would remove it.

Separately: `task.heartbeat` answers **200 unconditionally** — wrong pid, stale version, unknown task, lease
already stolen. Worker therefore cannot learn its lease is gone from heartbeat. It learns at its next fence, which
answers 409 on stale version. Any design that proposes to detect lease loss from heartbeat response is not
implementable.

## Known gaps

Two are design gaps rather than defects. Both block real workflows.

- **No way to cancel or abandon child.** `Effect.race`/`timeout` over `Durable` drops only waiter. Losing child
  stays pending, and attempt cannot complete while any child is unsettled. So racing external promise against
  seven-day timer fulfils root on day seven even if answer arrives on day one.
- **Lazy deadlines need durable timer.** Server flips pending promise to timed-out only when record is next read
  after its deadline. SDK-side `setTimeout` on worker that suspended is lost on restart, so long human-approval
  timeout means "times out when someone next looks".

Together these are why seven-day approval workflow cannot be written correctly today. Workaround — daily loop that
races one-day sleep, re-reading external each day — works, and costs up to a day of latency.

Also open: defects are laundered into typed failure channel (wire could carry distinction in header); leaf gets no
`AbortSignal`, so Promise-returning leaf cannot observe interruption; every request needs deadline, since
half-open connection otherwise wedges task permanently with lease renewed forever.

## Method note

Prototype was produced by cleanroom generation — independent agents implementing from specification alone, never
reading each other — which is what made convergence and divergence measurable. Conformance was judged by tree
checker that replays event log and asserts legality of every transition, plus whole-tree invariants.

Most transferable lesson is not about SDK. Across exercise, eight separate occasions arose where checker reported
"nothing wrong" when it should have reported "I cannot tell": summary that read only one of two available
verdicts; classifier keyed to one implementation's phrasing; harness that installed its own handler and so masked
defect SDK was reporting about itself; run whose conformance leg produced empty log and graded clean; leg that
suppressed wire events half its rules depended on; run-to-run variance mistaken for determinism, so identity that
was coincidence was read as evidence; conformance leg judged purely on legality of its trace, never on whether its
programs completed; and driver whose denominator was computed from whatever ran rather than from what should have
run. Every one made system look better than it was. Checker that cannot distinguish
"clean" from "I did not look" is worse than no checker, because it is believed.
