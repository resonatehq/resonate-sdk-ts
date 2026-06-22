// Parallel async/await execution engine for the Resonate SDK.
//
// Users write ordinary `async` functions and use `await`. `ctx.run`/`ctx.rpc`/
// `ctx.sleep` are eager (begin immediately) and return plain `Promise<T>`. There
// are no `begin*` variants and no future classes.

export type { AnyFunc, Context, DetachedHandle, Info } from "./context.js";
export {
  AsyncResonate,
  type AsyncResonateFunc,
  type ResonateHandle,
  type ResonateSchedule,
} from "./resonate.js";
