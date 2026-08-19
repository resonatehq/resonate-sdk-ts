// @resonatehq/base — shared protocol types and connection interfaces for the
// Resonate TypeScript SDK and its connectors.
//
// A connector package (e.g. @resonatehq/connector-nats) depends only on this
// package: the wire protocol types, the `Network`/`Source` protocols it
// implements, and the small set of helpers whose semantics must agree between
// the SDK core, the server, and every connector.

export {
  assertNetwork,
  assertSource,
  isNetwork,
  isSource,
  type Network,
  type Recv,
  type Send,
  type Source,
} from "./connection.js";
export { ResonateTimeoutException } from "./exceptions.js";
export { joinId, LINEAGE_SEP, ORIGIN_SEP, originOf } from "./ids.js";
export type { Logger, LogLevel } from "./logger.js";
export { delay, getEnv, randomUUID } from "./platform.js";
export * from "./types.js";
