// @resonatehq/connector-http — HTTP and SSE connections for the Resonate SDK.
//
// - `HttpConnection` is a `Network` (request/response only).
// - `SseConnection` is a `Source` (push only).
//
// Together they form the SDK's default remote transport; individually they let
// a process take exactly the half it needs (e.g. a serverless worker sends
// over HTTP and never listens).

export { HttpConnection, type HttpConnectionConfig } from "./http.js";
export { SseConnection, type SseConnectionConfig } from "./sse.js";
