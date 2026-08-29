# resonate-sdk-ts — Agent Orientation

> **Read the README first for the user-facing overview.** This file is the agent orientation: what to know before editing the SDK source. Treat the SDK as a product surface — it's the most-used Resonate SDK and ships to npm.

The TypeScript SDK for [Resonate](https://resonatehq.io) — a durable execution platform built around the Distributed Async Await pattern. Published as [`@resonatehq/sdk`](https://www.npmjs.com/package/@resonatehq/sdk) on npm.

## Status

- **Latest published:** `@resonatehq/sdk@0.10.2` on npm (2026-04-29)
- **Major line:** `0.10.x` — current generation, talks the v0.9.x Rust server protocol
- **Cadence:** active. The 0.10.x line shipped the renamed promise API (`.settle()` → `.resolve()` / `.reject()` / `.cancel()`) at 0.10.0; point releases have followed from there.

## Stack

| | |
|---|---|
| Runtime | **Node ≥22** |
| Package mgr | **npm** (canonical lockfile = `package-lock.json`) |
| Linter / formatter | **Biome** (`biome.json`) |
| Tests | **Jest** (`jest.config.cjs`) + **DST simulator** (`sim/main.ts`) |
| Build | `tsc --build tsconfig.build.json` (no bundler) |
| License | Apache-2.0 |

See the README for the full setup + install surface; this file's table is the agent-at-a-glance subset.

## Run

```bash
npm install            # install deps
npm run build          # tsc --build tsconfig.build.json → dist/
npm run type-check     # tsc --noEmit
npm test               # jest unit + integration
npm run dst            # tsx sim/main.ts (deterministic simulation)
npm run check          # biome check (lint + format + import organize)
npm run check:fix      # biome check --write (auto-fix lint + format + imports)
npm run fmt            # biome format --write (formatter only)
```

Run one-shot commands (build, test, lint, check, dst) freely; don't auto-start watchers or dev servers — the operator runs long-lived processes themselves.

## Architecture notes

- **Entry point** is `src/resonate.ts` — the `Resonate` class users instantiate with `new Resonate({ url })` and register functions against. `register()` accepts a generator function and tags it with metadata for the worker loop. Re-exported from `src/index.ts`.
- **Generator coroutine driver** is `src/coroutine.ts`. Resonate functions are generators; the driver advances them, awaits effects, and persists state via the durable promise primitives in `src/promises.ts`. This is the load-bearing abstraction — most subtle bugs live here.
- **Execution engine** is `src/core.ts` — schedules generator steps, handles retries, and drives the durable promise lifecycle.
- **Network layer** lives in `src/network/` — talks HTTP to the Rust server using the v0.9.x server protocol. Re-runs are idempotent on the server side; the SDK assumes server linearizability.
- **DST (deterministic simulation testing)** lives in `sim/`. `npm run dst` runs `sim/main.ts` which exercises the SDK against a simulated environment with a controllable clock and network. CI runs DST on every push.
- **Promise API surface** as of v0.10.x: `promise.resolve(value)`, `promise.reject(error)`, `promise.cancel()`. The pre-rename `promise.settle(id, status, options)` shape was replaced at the 0.9.x → 0.10.0 boundary; some external corpora (docs, examples, skills) may still reference the old shape — when you spot a stale `.settle()` reference, fix it where you find it.
- **Encryptor / codec** (`src/encryptor.ts`, `src/codec.ts`) are pluggable — applications wanting at-rest encryption supply their own.

## Rules

1. **No `npm publish` without explicit maintainer approval** for that specific publish, in the same session. CI publishes via the `publishConfig.provenance` flow, not local machines.
2. **No pushing to `main` directly.** Open a PR; CI runs the full test + DST matrix on every push.
3. **Server protocol is upstream.** When the Rust server bumps its protocol version, this SDK follows in lockstep — don't introduce SDK behavior that assumes an unreleased server protocol.
4. **Don't break public API on point releases.** The 0.10.x line is stable; rename / removal goes through a deprecation cycle in CHANGELOG and a major version bump.
5. **Voice in user-visible strings = Echo.** Error messages, log lines, and JSDoc all use the Echo voice (technical, precise, friendly-but-not-casual).

## Pointers

- [README](./README.md) — quickstart and external-facing overview
- [CONTRIBUTING.md](./CONTRIBUTING.md) — fork-and-branch workflow + dev setup
- [CLAUDE.md](./CLAUDE.md) — Claude Code-specific notes (coexists with this file; don't merge them)
- [TypeScript SDK guide on docs.resonatehq.io](https://docs.resonatehq.io/develop/typescript) — user-facing docs for the SDK
- [Resonate Server (Rust)](https://github.com/resonatehq/resonate) — the server this SDK targets
- [Example apps](https://github.com/resonatehq-examples) — `example-*-ts` repos demonstrate end-to-end patterns
- [npm package](https://www.npmjs.com/package/@resonatehq/sdk) — release listing
- [Distributed Async Await](https://www.distributed-async-await.io/) — the underlying programming model

## Privacy

- The SDK accepts JWT tokens via `RESONATE_TOKEN` (env) or constructor arg. Tokens are passed through to the network layer; never log them, never echo them back to users in error messages.
- The encryptor hook is the canonical place for application-level secret handling — don't add ad-hoc secret handling elsewhere in the SDK.

## Known gaps

- **No public API reference site.** TypeDoc config exists (`typedoc.json`); generated output is not currently published. When this lands, the user-visible docs flow goes through `npm run docs`.
- **Browser support is partial.** `scripts/run_in_browser.sh` exists for ad-hoc browser-runtime checks but the SDK is built and tested against Node ≥22 first; browser-runtime parity is not currently a release gate.
