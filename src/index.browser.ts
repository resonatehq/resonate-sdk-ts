// =============================================================================
// Browser entry point — `@resonatehq/sdk/browser`
// =============================================================================
//
// This is the browser-safe surface of the SDK. It sources networking from
// ./network/browser.js (fetch + EventSource only) and deliberately omits
// PushMessageSource, which needs `node:http`. Browser users opt in by importing
// from "@resonatehq/sdk/browser"; the default "@resonatehq/sdk" entry is the
// server build and re-exports everything here plus PushMessageSource.

export { WallClock } from "./clock.js";
export { Codec } from "./codec.js";
export type { Status } from "./computation.js";
export type { Context } from "./context.js";
export { Core } from "./core.js";
export { type Encryptor, NoopEncryptor } from "./encryptor.js";
export { ResonateTimeoutException } from "./exceptions.js";
export { AsyncHeartbeat, NoopHeartbeat } from "./heartbeat.js";
export { ConsoleLogger, type Logger, type LogLevel } from "./logger.js";
export { type HttpAdapter, HttpNetwork, PollMessageSource } from "./network/browser.js";
export { LocalNetwork } from "./network/local.js";
export type { Network, Recv, Send } from "./network/network.js";
export * from "./network/types.js";
export { OptionsBuilder } from "./options.js";
export { Registry } from "./registry.js";
export { Resonate, type ResonateFunc, type ResonateHandle } from "./resonate.js";
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
