# Method: generating SDKs from a specification, and measuring them

How the prototypes were produced and judged. This is the part most likely to transfer, because it is not specific
to Effect or to TypeScript.

## Cleanroom generation

Independent agents implemented from the specification alone. The constraints were strict and they are what makes
the results mean anything:

- No agent read another's implementation, or the harness, or the server's source.
- No package whose name contained the product name, and no web access on durable execution, workflow engines, or
  any competing product. Web access only for the specific library being targeted.
- Each could exercise an assigned server but never stop, restart, reconfigure or inspect it.
- A unique run-tag prefix on every id, group and pid, so concurrent runs could not collide.

Nine implementations resulted across three execution models (generator, async, Effect). Convergence then means
something: where all of them did the same thing, the specification determined it. Where they diverged, the
specification was silent, and the divergence is the specification's defect, not the implementation's.

Several specification defects were found exactly this way — by several SDKs failing *identically*. That signal is
the single most useful thing the approach produces, and it is only available because the implementations are
independent. It is also why the earlier prototypes were never modified during hardening: they are the control
group.

## The oracles

Three, in increasing strength.

1. **Typing probes.** Per-line `//E` (must be a type error) and `//O` (must compile) expectations against the
   normative declaration. Validated first against a stand-in typed exactly as the declaration, because a probe that
   passes against everything measures nothing. Trap found: contextual typing hides loose inference — `const n:
   number = await ctx.run(...)` compiles even when the SDK returns `unknown`, so the probe must use the result
   directly (`n.toFixed(2)`).
2. **Assignability.** One-way: the implementation must satisfy the declaration. Discovered to be insufficient on
   its own — all four async SDKs passed while returning loosely-typed results, because a free generic unifies with
   anything. Assignability says the shape is compatible; only the usage probe says the types are honest.
3. **The tree checker.** Replays an event log, guards every transition, asserts whole-tree invariants. See
   `harness/tree-checker.md`.

Plus a **seam emitter**, which matters more than it sounds: log emission must not require the implementing agent's
cooperation. Events were captured by interposition — an injected transport for the wire, a wrapper installed at
registration for bodies, a proxy on the context for the API, a proxy on the returned handle for waits. Body markers
in the source would have been both forgeable and a specification burden; interposition made two SDKs measurable
that had emitted nothing at all.

## The gate

Seven legs. A change that reduces any is rejected; raising a count is expected.

| leg | what it establishes |
|---|---|
| build | compiles |
| unit | in-process behaviour, including fault injection |
| cases | the conformance case list against a real server |
| extra | protocol edges the cases do not reach |
| typing | the declaration is satisfied and the types are honest |
| conformance, no faults | a legal execution tree on a 30-program corpus |
| conformance, 15% faults | the same under injected transport failures |

Two rules learned painfully. Every behaviour change needs a test **that would have failed before it** — and the
implementer must demonstrate the before-failure, not assert it. And the orchestrator runs the gate, never the
implementer.

### The gate's noise floor, measured

Three runs of identical code on the no-fault leg:

| counter | spread | comparison basis? |
|---|---|---|
| node count | 154, 154, 154 | **yes** |
| tree verdict | clean ×3 | **yes** |
| self-reports | 0 ×3 | **yes** |
| await / created / decide | 170-174 / 362-373 / 91-94 | **no** |

Event counts move about 2% run to run. An early conclusion drawn from event-count *identity* between two runs was
invalid — the identity was coincidence.

## The hardening loop

One reviewer picks the single next item and grades the previous one; one implementer does exactly that; the
orchestrator runs the gate. One item per iteration.

The shape that earned its keep is **review-grades-previous**. The reviewer found a real defect in the implementer's
work in every single iteration, including two defects introduced by the fix in the iteration before. It also
corrected the thing all four original reviewers had agreed on: they each proposed guarding the emit path on a
"closed" flag, which would have suppressed the decision event itself and a legitimate post-close settle. Four
independent reviewers converging on one remedy is not evidence the remedy is right.

Two measurements worth keeping about the loop itself:

- **Discovery rate did not decline.** Five iterations produced new findings at 1, 2, 1, 1, 1 per iteration. A
  codebase approaching production quality shows a falling rate. Readiness is when a reviewer finds nothing new, not
  when the inventory empties.
- **Two of five iterations introduced a defect of their own.** The work orders were careful; the surrounding
  invariants were not pinned tightly enough for change to be safe.

## Eight instrument failures

The most transferable finding is not about the SDK. Eight times, a checker reported "nothing wrong" when it should
have reported "I cannot tell":

1. An ad-hoc summary that read only one of two available verdicts.
2. A classifier keyed to one implementation's phrasing, which buried the real finding among false ones.
3. The fuzz runner installing its own violation handler — the only reason a process-killing default never surfaced.
4. Run-to-run variance mistaken for determinism, so a coincidence was read as evidence.
5. A conformance run that produced an empty log and graded **clean** (servers reclaimed; zero nodes).
6. A conformance leg judged purely on the legality of its trace, never on whether its programs completed.
7. A leg run in a mode that suppressed the wire events half the checker's rules depended on, leaving them inert
   for three iterations.
8. Test drivers exiting on "passed === results.length" — a denominator computed from whatever ran rather than from
   what should have run, so a dropped case printed "N of N passed" and exited 0.

Every one made the system look better than it was. Every one was found by accident or by an outside reviewer, never
by the checker itself.

The general rule: **a checker that cannot distinguish "clean" from "I did not look" is worse than no checker,
because it is believed.** Concretely — a verdict function should refuse to produce a verdict when its input cannot
support one (a sanity floor on nodes, events and failure ratio), should surface the subject's own self-reports
rather than only its own opinion, and should fail on a count it was given rather than a count it derives from the
run.
