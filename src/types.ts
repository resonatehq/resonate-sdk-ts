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

export type Result<V, E> = { kind: "value"; value: V } | { kind: "error"; error: E };

// Value

export interface Value<T> {
  headers: { [key: string]: string };
  data: T;
}

export type PromiseRecord = {
  id: string;
  state: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
  param: { headers: { [key: string]: string }; data: any };
  value: { headers: { [key: string]: string }; data: any };
  tags: { [key: string]: string };
  timeoutAt: number;
  createdAt: number;
  settledAt?: number;
};

export type TaskRecord = {
  id: string;
  version: number;
};

export type ScheduleRecord = {
  id: string;
  cron: string;
  promiseId: string;
  promiseTimeout: number;
  promiseParam: { headers: { [key: string]: string }; data: any };
  promiseTags: { [key: string]: string };
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
};

export type AcquiredTask = {
  kind: "acquired";
  task: TaskRecord;
  promise: PromiseRecord;
};

export type UnacquiredTask = {
  kind: "unacquired";
  task: TaskRecord;
};
