// =============================================================================
// Default entry point — `@resonatehq/sdk` (server / Node)
// =============================================================================
//
// The default build is the server build. It re-exports the full browser-safe
// surface from ./index.browser.js and adds PushMessageSource, the server-only
// message adapter that runs an HTTP server via `node:http`. Importing this
// entry therefore pulls in `node:http`; browser users should opt in to the
// browser build via "@resonatehq/sdk/browser" instead.

export * from "./index.browser.js";
export { PushMessageSource } from "./network/http.js";
