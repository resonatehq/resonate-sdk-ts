# Effect-TS durable-execution prototype: recovered record

## What this is

A research exercise ran outside this repository: a language-independent specification for a durable-execution SDK,
nine cleanroom implementations generated from it across three execution models, a set of conformance oracles to
measure them, and five iterations of production hardening on one Effect-TS implementation.

**The working tree was lost to container reclamation before it was committed.** The implementations themselves —
five Effect, four generator/async — are gone and are not reconstructible: only their diffs and measurements passed
through a durable record, never their full source. What survives is here, recovered from the session transcript.

Nothing in this directory is wired into the build. It is a record.

## What is here

| file | content | fidelity |
|---|---|---|
| `../adr/Effect-Execution-Model.md` | the design: how durable execution maps onto Effect, and why each collision resolves the way it does | written while the prototype existed; the primary document |
| `findings.md` | 19 findings with status, what measurement disproved, and what remains open | measurements quoted verbatim |
| `spec-amendments.md` | nine specification changes, each forced by a conformant implementation failing anyway | the exact before/after text |
| `method.md` | cleanroom generation, the oracles, the seven-leg gate, the review loop, and the eight instrument failures | reconstructed from the record |
| `harness/tree-checker.md` | the conformance oracle's design, its rules, and the three modelling facts it took several rounds to learn | reconstructed |
| `harness/tree-checker-recovered.py.txt` | the checker's source | **partial** — overlapping excerpts with small gaps, not runnable |
| `harness/grade.py` | the verdict function | complete |
| `harness/gate.sh` | the conformance leg of the gate | complete; paths are from the lost tree and kept verbatim |

## What is lost

- All nine implementations.
- The canonical specification text the implementations were generated from. The nine *amendments* survive with
  their exact substitution strings; the base document they amended does not.
- The fuzz program corpus (30 programs) and the 113-log trace corpus the measurements were taken over.
- The in-process mirror's source, and the typing probe templates.

## Reading order

`../adr/Effect-Execution-Model.md` first — it is the argument, and the rest is support. Then `method.md` if the
interest is in how to generate and measure implementations from a specification, or `findings.md` if the interest
is in what breaks in a durable-execution SDK and which plausible-sounding defects turn out not to exist.

## The one thing worth taking away

Eight separate times in this exercise, a checker reported "nothing wrong" when it should have reported "I cannot
tell" — an empty run that graded clean, a leg that suppressed the events half its rules needed, a denominator
computed from whatever happened to run. Every one made the system look better than it was, and not one was found
by the checker itself.

The prototypes are gone and that is a real loss. The catalogue of ways a measuring instrument lies to you is not
specific to them, and is probably worth more.
