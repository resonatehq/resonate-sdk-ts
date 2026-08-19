# CLAUDE.md

This file helps AI coding agents understand the resonate-sdk-ts repository.

## What this repo is

The Resonate TypeScript SDK (`@resonatehq/sdk`) lets developers write reliable, distributed applications. The SDK coordinates with the Resonate Server to persist function execution state, enabling long-running workflows that survive process restarts. It ships two execution engines that speak the same protocol to the same server:

- **Generator engine** (`@resonatehq/sdk`, `src/`) — workflows are TypeScript generator functions (`function*`) driven by a coroutine.
- **Async engine** (`@resonatehq/sdk/async`, `src/async/`) — workflows are ordinary `async` functions; durable operations are eager and awaited.

## Build

```shell
npm install
npm run build        # compiles TypeScript via tsc (output in dist/)
npm run type-check   # type-check without emitting
```

Requires Node >= 22.

## Test

```shell
npm test             # runs Jest (jest.config.cjs)
npm run dst          # runs the deterministic simulation (sim/main.ts)
npm run dst:diff     # differential test: async engine vs generator engine (see diff-testing.md)
```

Individual test files live in `tests/` (generator engine) and `tests/async/` (async engine). The DST (deterministic simulation testing) lives in `sim/`.

## Lint / Format

```shell
npm run check        # Biome linter check
npm run check:fix    # Biome linter check with auto-fix
npm run fmt          # Biome formatter
```

## Monorepo layout

This is an npm-workspaces monorepo. The root package **is** the core SDK
(`@resonatehq/sdk`, source in `src/`), mirroring the Python SDK where the
workspace root is the core package. The shared protocol package, connector
packages, and platform FaaS shims live under `packages/*` and each publish
independently:

| Package | Dir | Runtime | Publishes as |
|---------|-----|---------|--------------|
| core | `.` (root) | Node | `@resonatehq/sdk` |
| base | `packages/base` | any | `@resonatehq/base` |
| connector-nats | `packages/connector-nats` | Node | `@resonatehq/connector-nats` |
| connector-pg | `packages/connector-pg` | Node | `@resonatehq/connector-pg` |
| aws | `packages/aws` | Node (Lambda) | `@resonatehq/aws` |
| gcp | `packages/gcp` | Node (Cloud Functions) | `@resonatehq/gcp` |
| cloudflare | `packages/cloudflare` | Cloudflare Workers | `@resonatehq/cloudflare` |

**Connections, networks, and sources.** The transport layer is split into two
protocols defined in `@resonatehq/base` (`packages/base/src/connection.ts`):
`Network` (request/response: `send`/`start`/`stop`) and `Source` (push:
`recv`/`unicast`/`anycast`/`match`/`pid`/`group`/`start`/`stop`). Every
implementation is a **connection**: `HttpConnection` (Network only),
`SseConnection` (Source only), and the in-process `LocalConnection` (both)
live in core (`src/connections/`) — HTTP + SSE are the SDK's default remote
transport; `NatsConnection` and `PostgresConnection` (both) live in their own
connector packages. A `Resonate` instance uses exactly one network
and one or more sources — `sources[0]` is the primary source and owns the SDK
identity. Resolution rules (url > network > env > local, dual-role defaults,
fail-fast guards) are shared by both engines in `src/connections/resolve.ts`.
`@resonatehq/base` also carries the wire protocol types (`Request`/`Response`/
`Message`), `ResonateTimeoutException`, `Logger`, id helpers, and platform
shims — a new connector package should depend only on `@resonatehq/base`
(as a peer dependency, so class identities like `ResonateTimeoutException`
stay singletons).

Shims declare a normal semver dep on `@resonatehq/sdk` (publishable). For local
dev, the root `overrides` field (`"@resonatehq/sdk": "file:."`) symlinks that dep
to the local core so shims build against local source, not the registry — this
is npm's stand-in for uv's `workspace = true` (npm won't self-link the root as
a workspace member). Run `npm install` at the root. Build order matters:
`npm run build` at the root builds `@resonatehq/base` first, then core;
`npm run build:packages` builds every workspace package. Jest and the root
`tsconfig.json` map `@resonatehq/base` / `@resonatehq/connector-*` to
workspace *source*, so tests and `type-check` never require a package build.

## Key directories

| Path | Purpose |
|------|---------|
| `src/` | Generator engine source (`@resonatehq/sdk`) |
| `packages/` | Shared base, connectors, and platform FaaS shims (see Monorepo layout above) |
| `packages/base/` | `@resonatehq/base`: wire protocol types, `Network`/`Source` interfaces, shared helpers |
| `packages/connector-nats/` | `NatsConnection` (Network + Source) |
| `packages/connector-pg/` | `PostgresConnection` (Network + Source) |
| `src/resonate.ts` | Main `Resonate` class — entry point for users |
| `src/context.ts` | `Context` type passed to every Resonate function |
| `src/core.ts` | Execution engine |
| `src/coroutine.ts` | Generator coroutine driver |
| `src/promises.ts` | Durable promise primitives |
| `src/schedules.ts` | Schedule API |
| `src/connections/` | `HttpConnection`, `SseConnection`, `LocalConnection` (in-process server), and the shared network/sources resolution, used by both engines |
| `src/async/` | Async engine source (`@resonatehq/sdk/async`): `resonate.ts` (`Resonate`), `context.ts` (eager ops, `DurablePromise`), `core.ts` (task driver) |
| `tests/` | Jest unit and integration tests (`tests/async/` for the async engine, `tests/connections/` for connections/wiring, `tests/equivalence/` for cross-engine differential tests) |
| `sim/` | Deterministic simulation (DST) for chaos/reliability testing |
| `dist/` | Compiled output (not committed) |

## Key conventions

- **Two engines, one protocol**: both engines create the same durable promises and tasks against the same server. Changes to shared modules (`packages/base/`, `src/connections/`, `src/codec.ts`, `src/options.ts`, `src/registry.ts`, `src/util.ts`, `src/retries.ts`) affect both.
- **Connections**: `Network` (send) and `Source` (recv + addressing) are independent protocols; a class implementing one or both is a *connection*. `Resonate` takes `network` and `sources` — never a conflated "network" that does both implicitly. New transports go in their own `@resonatehq/connector-*` package depending only on `@resonatehq/base`.
- **Generator engine**: workflows are generator functions (`function*`). Yielding `context.run(...)` or `context.sleep(...)` creates durable checkpoints. Use `yield*` with `context.run()` to properly delegate to sub-generators. Do not convert generator workflows to async/await — they belong to this engine; the async engine is a separate implementation, not a rewrite target.
- **Async engine**: workflows are ordinary `async` functions. Durable operations are **eager** — `ctx.run(...)` starts immediately and returns a `DurablePromise` — and there are no `begin*` variants. Retries default to `Never` (opt-in via `retryPolicy`). Inside a workflow, `await` must only target durable promises; wrap side effects in `ctx.run`.
- **Registration**: functions must be registered with `resonate.register(fn)` before they can be invoked (both engines).
- **Serialization**: values cross the wire through `src/codec.ts`; a custom `Encryptor` can be provided.
- **Options**: per-call options (timeout, tags, target, retry policy) are built via `src/options.ts` and passed as a trailing argument.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the fork-and-branch workflow. PRs should be squash-merged.
