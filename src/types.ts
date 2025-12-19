import type { Context, DIE, Future, LFC, LFI, RFC, RFI } from "./context";
import type { Options } from "./options";

// Resonate functions

export type Func = (ctx: Context, ...args: any[]) => any;

export type Params<F> = F extends (ctx: Context, ...args: infer P) => any ? P : never;
export type ParamsWithOptions<F> = [...Params<F>, Options?];

export type Yieldable<T = any> = LFI<T> | LFC<T> | RFI<T> | RFC<T> | Future<T> | DIE;

export type Return<T> = T extends (...args: any[]) => Generator<infer __, infer R, infer _>
  ? R // Return type of generator
  : T extends (...args: any[]) => infer R
    ? Awaited<R> // Return type of regular function
    : never;

// Result

export type Result<V, E> = { tag: "value"; value: V } | { tag: "error"; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { tag: "value", value };
}

export function ko<T>(error: T): Result<never, T> {
  return { tag: "error", error };
}

// Callback

export type Callback<V, E> = (res: Result<V, E>) => void;

// Value

export interface Value<T> {
  headers?: Record<string, string>;
  data?: T;
}
