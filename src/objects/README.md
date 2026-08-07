# Resonate Durable Objects — prototypes (EXPERIMENTAL)

This directory prototypes **durable objects** (virtual actors) on top of the
Resonate protocol. Nothing here is public SDK surface; it exists so the design
alternatives can be compared on runnable code. The full analysis — prior art
(Temporal entity workflows, Restate virtual objects, Cloudflare Durable
Objects), semantics, protocol mechanics, and the recommendation — lives in the
`resonate-specification` repo: `design/durable-objects.md`.

One definition (`defineObject`) mounts on three interchangeable runtimes plus
one rejected alternative:

| Variant | File | One-liner | Protocol extension? |
|---|---|---|---|
| A — chain | `chain.ts` | The object *is* the ordered chain of its message promises; sender CAS-appends, executor awaits its predecessor (server-ordered), state snapshots ride message values | none |
| B — loop | `loop.ts` | Temporal-style generation loop with a pre-created mailbox of latent promises, roll (continue-as-new) and idle passivation | none |
| C — serial | `serial.ts` | One tag (`resonate:serial`) makes the server serialize + chain-stamp invocations; objects collapse into ordinary `ctx.rpc`/`ctx.detached` calls | yes — emulated by `SerialDispatchNetwork` |
| D — cas | `cas.ts` | Optimistic client-side state folds; rejected as the primitive (no durable effects), kept for comparison | none |

Both headline problems are solved structurally in every accepted variant:

* **Unbounded replay**: state is materialized as a snapshot at each commit
  point (message value / generation value), and the journal (durable children)
  is scoped to one message (A, C) or one bounded generation (B). Replay never
  grows with object lifetime — Restate's journal-per-invocation insight,
  reconstructed from durable promises alone.
* **Unbounded live objects**: objects are virtual (Orleans-style). An idle
  object holds no task, no worker memory, and no pending promise (A, C always;
  B after passivation) — only settled records, whose lifecycle is the server's
  existing retention concern.

Recursive integration is uniform: functions call objects (`objects.in(ctx)`),
objects call functions (`octx.run`/`octx.rpc`), objects call objects
(`octx.object(...)`), with `call` (durable request/response), `send` (durable
one-way), `read` (snapshot, unserialized where the variant allows), and
self-`call` deadlock detection. Tests: `tests/objects/`.
