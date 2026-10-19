# Specification amendments

Nine changes to the durable-execution specification, each forced by an implementation that was conformant and
failed anyway, or by a clause no implementation could satisfy. Recovered from the build script that applied them.

These matter beyond the lost prototype: the specification is what cleanroom implementations are generated from, so
a clause that mis-grades a correct implementation propagates into every future one.

## 1. The mirror boundary condemned observing, not just acting

The clause read:

> After the attempt closes on a **platform failure**, any event other than abandoned is a violation, and no node
> may enter settled because of the failure (R6).

The two halves disagree. The second is right and is about causation. The first condemns the mere *arrival* of a
response to a request issued before the failure — which a correct implementation cannot prevent. Our own fault logs
carry **75-93 such arrivals per run** in every Effect build, so a correct SDK reported itself in violation, and in
one build a process-killing default handler turned each one into an availability incident.

Amended to:

> After the attempt closes on a **platform failure** the attempt is abandoned: no action may be sent, no node's
> function may start, and no node may enter settled, running or parked because of the failure. A response to a
> request issued before the failure may still arrive. Observing it is legitimate and it may be recorded, since the
> record is true and the next attempt may use it; acting on it is not. Nothing may be resumed, started or sent on
> the strength of a late observation, and a node parked when the attempt decided makes no further progress: clause
> (4) exempts a function still running, never a parked one (R6).

## 2. Mirror independence claimed where it cannot exist

The specification asked for "a second, independent model of the same attempt, fed by the same events", and made a
disagreement between the two a defect. But `running`, `parked` and `returned` are entered from events the runtime
emits *out of its own conclusions*, so the mirror can only copy them — and a mis-classified park, the one failure
the invariant exists to prevent, is believed by both models. The claim of independence was doing no work exactly
where it was most needed.

Amended to require the mirror to derive **ordinal contiguity, the hold rule, the descendant walk behind a settle,
and the completeness of the suspend set** from first principles, to permit it to track the copied states for
context without being credited with checking them, and to require that a mirror assertion **reports and never
terminates the process**.

## 3. Retry eligibility: runtime history or static

"Retry per policy only while the body performed no durable operation" reads as a question about execution history,
to be answered at throw time. Under a model where a leaf is structurally incapable of a durable operation, the
answer is known statically at the call site — and the conformance case "a body that performed a durable op is never
retried" becomes unexhibitable, so a conformant implementation is held to a case it cannot demonstrate.

Amended to state that eligibility **may** be fixed statically at the call site **or** derived from what the body
has done, that both conform, and that under a static rule there is nothing to exhibit for that case.

## 4. "Any user tags" had no way in

Every child was specified to carry `resonate:origin`, `resonate:parent`, `resonate:branch`, `resonate:scope`,
"and any user tags" — while no child option bag in the normative declaration carried a `tags` field. The clause was
unsatisfiable, and the prototype's omission of it was the one deviation nobody had recorded, because there was
nothing to record.

Amended: `tags?: Record<string, string>` added to all four child option bags, and the specification now states that
the reserved `resonate:*` keys are set by the SDK and win over a user key of the same name.

## 5. The root is never fenced

The specification said every create and settle in an attempt goes through `task.fence` with the task version.
Measured: `task.fence` **refuses an action naming the task's own promise** — 400, "Action ID must not equal the
task ID". So the rule is false for the root, which settles through `task.fulfill` alone.

## 6. Due versus pending timers

The specification said a due timer's acquire answers 409. Measured: acquire answers **200 while the timer is
pending** and **409 once it is due**. Both the specification and a reviewer who contradicted it were half right.

The consequence is a cost worth stating in the spec rather than discovering: recognising a timer requires acquiring
it first, so a pending timer task is re-acquired on every re-dispatch — about one request per second per
outstanding durable sleep. Putting a timer flag in the execute message head would remove it.

## 7. The quiescent clause is defensive

"A quiescent attempt with nothing to await is a platform error" is unreachable from any legal program — the
implementation's own test for it had to inject a failure to get there. Marked as a defensive check and not a case
to test, so nobody else spends a test on it.

## 8. Two self-contradictions in the wire protocol, resolved by experiment

Both halves were in the same document, and an implementer had to pick.

| question | document said | measured |
|---|---|---|
| `promise.create` on an existing id | "409 … the server still returns the existing record" in one place, "idempotent 200; there is no 409 on create" in another | **200** with the existing record, never 409 |
| `task.fence` preload | "the task's branch and is non-empty" in one place, "returns an empty preload" in another | **non-empty**, and it grows as children are created |

## 9. The execution-log clauses

The development trace format carried eight ordering clauses. Four were wrong.

- **C5 suspend completeness** said the suspend set lists *exactly* the unsettled remotes. The specification and the
  conformance cases both explicitly permit **over-inclusion** (naming an already-settled remote forces a redirect
  and a re-preload, which some designs do deliberately). Two conformant implementations got opposite verdicts.
  Changed to "a superset of … and a subset of the attempt's remote nodes".
- **C6 quiet at decision** is *necessarily* false on a platform-failure decision, because clause (4) licenses a
  function that is still running to run to its end. The implementation's own checker had silently carved this out;
  the specification now owns the exemption.
- **C7** clarified: recording the response to a settle issued *before* the failure is not a violation.
- **C8 withdrawn.** It read a throw after a failed request as evidence the body observed the failure. It is not —
  a leaf that throws for its own reasons microseconds later is conformant and trips it. Causation is not
  recoverable from a log; this belongs in the mirror, which knows whether the raise reached user code.
- **C9 added:** late observations are inert. After a decision, a node that was parked at that decision emits
  nothing further in the attempt. Waking a waiter on the strength of a late observation is the one forbidden act
  that leaves no trace on the wire, since no request accompanies it.
