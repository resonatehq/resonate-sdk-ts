import type { Context } from "./context";

// Expression
export type InternalExpr<T> = InternalAsync<T> | InternalAwait<T> | InternalReturn<T>;

// The type of a resonate function
export type Func = (ctx: Context, ...args: any[]) => any;

export type InternalAsync<T> = {
  type: "internal.async";
  id: string;
  kind: "lfi" | "rfi";
  mode: "eager" | "defer";
  func: Func;
  args: any[];
};

export type InternalAwait<T> = {
  type: "internal.await";
  id: string;
  promise: Promise<T>;
};

export type InternalReturn<T> = {
  type: "internal.return";
  value: Literal<T>;
};

// Values

export type Value<T> = Nothing | Literal<T> | Promise<T>;

export type Nothing = {
  type: "internal.nothing";
};

export type Literal<T> = {
  type: "internal.literal";
  value: T;
};

export type Promise<T> = PromisePending | PromiseCompleted<T>;

export type PromisePending = {
  type: "internal.promise";
  state: "pending";
  id: string;
};

export type PromiseCompleted<T> = {
  type: "internal.promise";
  state: "completed";
  id: string;
  value: Literal<T>;
};
