export type { Network, Recv, Send, Source } from "@resonatehq/base";
// Wire protocol types, guards, connection protocol assertions, and shared
// helpers all come from @resonatehq/base.
export * from "@resonatehq/base";
// Connections: HTTP/SSE ship in @resonatehq/connector-http (re-exported here
// because they are the SDK's default remote transport); the in-process local
// simulation lives in core. NATS and Postgres moved to their own packages
// (@resonatehq/connector-nats, @resonatehq/connector-pg).
export {
  HttpConnection,
  type HttpConnectionConfig,
  SseConnection,
  type SseConnectionConfig,
} from "@resonatehq/connector-http";
export { WallClock } from "./clock.js";
export { Codec } from "./codec.js";
export type { Status } from "./computation.js";
export { LocalConnection, Server } from "./connections/local.js";
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
