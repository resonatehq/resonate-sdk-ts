export type { Network, Recv, Send, Source } from "@resonatehq/base";
// Wire protocol types, guards, connection protocol assertions, and shared
// helpers all come from @resonatehq/base.
export * from "@resonatehq/base";
export { WallClock } from "./clock.js";
export { Codec } from "./codec.js";
export type { Status } from "./computation.js";
// Connections: the SDK's default transport (HTTP + SSE) and the in-process
// local simulation live in core. NATS and Postgres moved to their own packages
// (@resonatehq/connector-nats, @resonatehq/connector-pg).
export { HttpConnection, type HttpConnectionConfig } from "./connections/http.js";
export { LocalConnection, Server } from "./connections/local.js";
export { SseConnection, type SseConnectionConfig } from "./connections/sse.js";
export type { Context } from "./context.js";
export { Core } from "./core.js";
export { type Encryptor, NoopEncryptor } from "./encryptor.js";
export { ResonateTimeoutException } from "./exceptions.js";
export { AsyncHeartbeat, NoopHeartbeat } from "./heartbeat.js";
export { ConsoleLogger, type Logger, type LogLevel } from "./logger.js";
export { OptionsBuilder } from "./options.js";
export { Registry } from "./registry.js";
export { Resonate, type ResonateFunc, type ResonateHandle } from "./resonate.js";
export { Constant, Exponential, Linear, Never, type RetryPolicy } from "./retries.js";
export {
  awaitThenResumeOrSuspend,
  blockIsSole,
  dedupIsSole,
  type Event,
  exclusiveLifecycle,
  isWellFormed,
  rootSpawn,
  rpcHasCallee,
  runHasCallee,
  spawnIsFirst,
  type Trace,
  TraceCollector,
  terminalIsLast,
  uniqueSpawn,
  uniqueTerminal,
} from "./trace.js";
export type { Effects, Func } from "./types.js";
