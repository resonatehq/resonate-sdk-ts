# The tree checker

A conformance oracle for durable execution. It replays an event log into a tree of promise nodes and asserts, at
every event, that the transition is legal — then asserts whole-tree invariants after each one. Roughly 237 lines
of Python. `tree-checker-recovered.py.txt` beside this file holds the recovered source; this file is the design,
which is the part worth keeping.

## Why a tree and not a trace

The first version checked the trace directly: a list of named rules, each a comprehension over the event list
("every settle is preceded by a return", "no create after a platform failure"). That works and it is cheap, but it
cannot express the properties that matter most, because those are statements about *state* rather than about
sequence — "a node is running and not parked at the decision" has no local witness in the event list.

So: build the tree, and distinguish two kinds of assertion.

- A **transition guard** says which step is illegal. Checked when the event arrives.
- A **state invariant** says which state is impossible. Checked after every event.

Both are needed. A resume that fires too early leaves no trace in the resulting state, so only a guard catches it;
a node that ends up settled with an unsettled child may have got there by a path no single guard rejects.

## Three modelling facts that were learned the hard way

Each of these was found because several independent SDKs failed identically, which is the signal that the checker
is wrong rather than the implementations.

1. **Transient state is per worker.** Running, parked and the set of open waits reset when a task is re-acquired.
   Durable facts (a promise exists; its value is known) survive attempts. Keeping one global state per node makes
   every multi-worker program look broken.
2. **A child's mint and create belong to the *parent's* attempt**, not to the child's. The child has no attempt of
   its own until its body starts.
3. **Knowledge is per task view `(worker, task_root)`, never per worker.** A task learns a promise is durable or
   settled only through its own wire responses, preloads and messages — never through another task that happens to
   share the process. Modelling knowledge per worker makes two tasks on one worker leak information to each other,
   and the leak looks like a conformance pass, which is worse than a failure.

## The rules

Named descriptively, not numbered, so a violation reads as a sentence.

| rule | what it forbids |
|---|---|
| `ordered_creation` | a create sent while the previous sibling is not yet durable |
| `ordinals_contiguous` | a gap in a parent's child ordinals |
| `creation_monotone` | child *k+1* durable while *k* is not |
| `child_minted_while_parent_not_running` | a mint from a parent that is not running |
| `child_implies_parent_invoked` | a child existing when its parent's body never ran |
| `invoke_after_durable` / `running_implies_durable` | a body starting before its create is acknowledged |
| `running_implies_not_settled` | a body running for an already-settled promise |
| `settle_after_return` | a settle sent from a state other than returned |
| `settle_after_children` | a settle while a non-detached child's value is unknown |
| `settled_parent_implies_settled_children` | the same, as a state invariant |
| `settled_implies_durable` | knowing a value without knowing the promise exists |
| `resume_after_durable` | a waiter resumed while every awaited target is still unsettled |
| `replay_never_invokes` | re-executing a body whose result was preloaded |
| `retry_only_leaves` | retrying a body that already minted children |
| `suspend_set_complete` | a pending remote missing from the suspend set (over-inclusion is legal) |
| `quiet_at_decision` | a fenced request in flight, or a node running and not parked, at the decision |
| `failure_settles_nothing` | any action after a platform failure |
| `nothing_after_decision` | a create, invoke or settle **sent** after the decision |
| `late_observation_is_inert` | a node **parked at the decision** making progress afterwards |
| `wait_targets_a_node` / `never_wait_on_detached` | awaiting something unminted, or a detached child |
| `complete_before_return` | completing with the root not returned |
| `complete_with_unsettled_child` | completing with a child unsettled |
| `return_without_running` | a return from a state other than running |

## `late_observation_is_inert`, and why it is shaped the way it is

This rule is the one worth understanding, because the first two attempts at it were both wrong.

The specification said: after a platform failure, any event other than `abandoned` is a violation. That is too
strong. A response to a request issued *before* the failure can arrive after it, and observing it is legitimate —
the record is true, and the next attempt may use it. What must not happen is *acting* on it.

So the rule splits along observe/act:

- The knowledge handlers (`durable`, `settle_res`, `settled`) record unconditionally. Deliberately. They carry a
  comment saying so, because the obvious "fix" is to guard them, and that would be wrong.
- `nothing_after_decision` catches the **sends** — a create, invoke or settle issued after the decision.
- `late_observation_is_inert` catches the one forbidden act that leaves **no trace on the wire**: a waiter woken
  in-process. No request accompanies it, so a transport-level checker cannot see it.

First cut keyed on a post-decision `resume` event. Nearly dead code: at least one SDK emits `resume` only when its
await count reaches zero, so the wake can happen untraced. The rule now snapshots which nodes are *parked at the
decision* and flags any later progress by one of them — a resume, a mint, or a return. That is the act itself
rather than one of its optional signals.

Clause (4) of the spec's platform-failure rule exempts a function still *running* from the quiet requirement; it
does not exempt a parked one. Nobody is entitled to wake a parked node once the task is going back to the server.

### It fires, and it was proved before it did

Over a 113-log corpus the rule fired on two SDKs under fault injection (39 hits and 2 hits). Before that was
known, it was proved against two fixtures, because **a rule that only ever reports "clean" is indistinguishable
from a rule that does nothing**:

- `late-obs-only.jsonl` — an observation after a `platform_error` decide. Clean.
- `late-act.jsonl` — the same log plus one `resume`. Exactly one violation.

## What the checker cannot do

- It has no view of causation. "A body threw after a request failed" does not tell you the body observed the
  failure, and no log can. That belongs in an in-process mirror.
- It reports node count and verdicts reliably; **event counts are not a comparison basis**. Three runs of
  identical code on the same corpus gave await 170-174, created 362-373, decide 91-94 while node count held at 154.
