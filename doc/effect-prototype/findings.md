# Defect inventory

Findings against the Effect-TS prototype, from four independent static reviews (one adversarial-correctness lens,
one ergonomics lens where the reviewer wrote three workflows the test suite did not contain, one Effect-idiom lens,
one spec-audit lens), plus five hardening iterations and the measurements taken during them.

Severity ordering here is the orchestrator's, not the reviewers'. It differs from theirs on one major point and the
measurement supports the change: three of four reviewers ranked F1 first, and F1 was measured to produce zero
forbidden acts in 450 program-runs.

**"Measured"** means someone ran it and the numbers are quoted. **"Reasoned"** means it was read off the source.
Several entries that four reviewers believed turned out false under measurement; they are kept, marked, because
knowing which plausible claims were wrong is as useful as the true ones.

## Closed

| # | finding | resolution |
|---|---|---|
| F3 | An interrupted durable await left the node marked parked. The `Effect.async` cleanup decremented the await count but did not clear `parkedOn`, emit `resume`, or recompute — where the success path did all three. Any `race`/`timeout`/`raceAll` over a durable reference left a node parked while its fiber ran, so the engine could suspend under a live body. **Measured: the body's next durable operation never happened** (`markerRan: 0`, child never created). | Made the cleanup symmetric with the success path, under a `!closed` guard. Guard is load-bearing: without it, teardown's own interrupts emit `resume` after close and the mirror raises R6 (measured 24/25 vs 25/25). |
| F4 | No request timeout anywhere: a bare `fetch` with no `AbortSignal`. A half-open connection wedges a task permanently — the in-flight count never drops, so the attempt never closes, the task stays held, and the heartbeat renews the lease forever. The one failure mode that does not degrade into release-and-retry. | Per-request `AbortController`, 15s default derived from `ttl/2`, `0` disables. |
| F6 | The default mirror-violation handler rethrew from a `setTimeout` — an uncaught exception that killed the worker and every lease it held, on by default whenever `NODE_ENV !== "production"`. The measured corpus raises **20-30 violations per fault-injected run**; they were log lines only because the harness installed its own handler. | `console.error` and nothing else; `RESONATE_MIRROR=strict` restores the rethrow for CI. |
| F17 | `ttl` unvalidated. **Measured:** `ttl: NaN` → `setInterval` fires 200 times in 234ms (~855 heartbeat req/s); `ttl: 5e9` → `TimeoutOverflowWarning`, clamped to 1ms, 200 fires in 228ms, so the largest writable ttl is also the fastest heartbeat; `JSON.stringify({ttl: NaN})` is `{"ttl":null}`, putting `null` on the wire. `readonly ttl: number` demonstrably held the string `"60000"`. | Throws a `TypeError` at construction for anything not a safe integer in `[1, 2147483647]`. Deliberately throws rather than defaulting: a ttl carries intent the SDK cannot guess and goes on the wire. |
| F18 | `requestTimeout` above 2^31-1 silently aborted **every** request: `Number.isFinite` admits it, `setTimeout` clamps an overflowing delay to 1ms. **Measured:** `setTimeout(fn, 3e9)` fired after 2ms. The inverse of the safety property, and strictly worse than the bug it was introduced fixing. | Range tightened to `(0, 2147483647]`, sub-millisecond floored to 1ms. |
| F19 | Every `task.release` path spun against the server with no backoff, **silently**. **Measured** with the real SDK against the real server: one worker, one task, 7 acquire + 7 release by t+3s, 51+51 by t+6s, 86+86 by t+12s — 6-15 cycles/s, still climbing, with zero output at the default log level. The protocol names this the SDK's job: "the server does not pace re-dispatch, so a worker that releases on every attempt will spin." Triggers are a sick control plane or a routine misdeploy. | Consecutive-release backoff, 100ms doubling to a 5s cap, cleared on progress, guard before the acquire so a refused dispatch costs zero requests. |

## Disproved or downgraded by measurement

| # | claim | what measurement showed |
|---|---|---|
| F16 | `onExecute` guards on `held.has` *before* awaiting the acquire, so two execute messages for one task could both acquire and both drive it, stranding one attempt on a stale fence. | **False.** Two concurrent acquires for one task at the same version return **200 and 409** — the server's fencing token already serialises it, so the second returns early and `drive` is never entered twice. The pre-check window is real but harmless. |
| F5 | The heartbeat discards its response, so a lost lease is invisible. | **The remedy is unimplementable.** `task.heartbeat` answers **200 unconditionally** — wrong pid, stale version, unknown task, lease already stolen — with no per-task result. There is no 404/409 to inspect. A worker can only learn its lease is gone at its next fence, which answers 409 on a stale version. Residue is observability only. |
| F12 | A settled root after `task.acquire` is dropped with no fulfil, suspend or release, leaving the task to be re-dispatched forever. | **Downgraded to a benign lease leak.** A task whose promise settles out from under it is **never re-dispatched** (0 executes in 10s, measured). The lease leaks until it lapses; nothing wedges. |

## Open

Ordered by the orchestrator's judgement of expected harm.

| # | finding | status |
|---|---|---|
| F2 | `awaitRef` parks an **act** node. Since a leaf was allowed to return an `Effect`, the leaf's own node is the current node, and the await path has no kind check where the mint path has a fiber-ownership backstop. Undercuts the headline claim that `act` makes invariant F a type: the type closes the shape of the leaf, not what the leaf's Effect may touch. Not exercised by any corpus program. | verified in source |
| F9 | No way to cancel or abandon a child. `race`/`timeout` over a durable reference drops only the waiter; the losing child stays pending and an attempt cannot complete while any child is unsettled. **Design gap, not a patch.** | reasoned |
| F10 | Lazy deadlines depend on a worker-local `setTimeout`, lost on restart. The server flips a pending promise to timed-out only when the record is next read after its deadline, so a long timeout means "times out when someone next looks". **Design gap.** With F9, this is why a seven-day human-approval workflow cannot be written correctly. | reasoned |
| F1 | Post-close acknowledgement continuations unguarded: the emit path, the create post-await region, and the settle acknowledgement have no `closed` check, where every other post-close path does. **Measured: zero forbidden acts in 30 programs x 15% faults, across three variants.** Three reviewers ranked it first; the measurement does not support that. | verified in source; harm not reproduced |
| F7 | Defects laundered into the typed failure channel, so `catchAll` typed `E` can receive a `TypeError`. The wire could carry the distinction in a header for free. | reasoned |
| F8 | No `AbortSignal` in the leaf info object, so a Promise-returning leaf cannot observe interruption; teardown abandons after 2s. The "at most twice" window is unbounded in time. | reasoned |
| F11 | Teardown spends up to 2s of the lease *before* the fulfil is sent. Nothing requires the scope to close first. | reasoned |
| F13 | Documentation described a superseded build. A type named in three documents existed only in a pre-change backup; one report's cost column had three debits a later relaxation had voided, so its verdict needed recomputing rather than editing. | verified |
| F14 | Hygiene: a dead `if (false)` branch, three stale source copies in the tree, orphan doc comments above the type they contradicted, driver internals public in the emitted declarations. | verified |
| F15 | The SDK's own conformance checker still implemented a retired clause set after the spec was amended. | verified |
| — | A pre-existing program-timeout rate under fault injection: **2-3 timeouts per 90 program-runs**, reproducible on demand at two specific programs. Ruled out as caused by the backoff (control: 2/90 without it), by the ttl change (inert on that leg), and by server-state accumulation (killed and restarted the in-memory server; same result). Cause is in one of three places — the SDK's recovery latency, the harness's 20s program timeout, or the fault model. | measured, undiagnosed |
| — | An unaddressed half of F19: the invisibility. The one report fires at exactly the fifth consecutive release and goes to a sink silent unless a debug env var is set. A worker refusing every dispatch is still silent by default. | verified |
| — | The release backoff refuses dispatches that **did** make progress. Only the suspend and fulfil paths clear the count, but the release that dominates under faults is the platform-failure path, measured reaching 8-12 consecutive on attempts that fenced and created children before dying. Bounded (≤5s, self-resetting) and measured not to be a net regression. | verified |
| — | The backoff's cap and its consecutive-reset window are the same constant, so the top of the schedule erases itself: once the delay reaches the cap the next release is necessarily outside the window, the count resets, and the schedule sawtooths rather than settling. Benign, accidental, and the code comment describes a steady state the code cannot reach. | verified |
