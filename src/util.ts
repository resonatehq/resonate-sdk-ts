import type { DurablePromiseRecord, TaskRecord } from "./network/network";
import { type Options, RESONATE_OPTIONS } from "./types";

// Base unit: milliseconds
export const MS = 1;
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

export function assert(cond: boolean, msg?: string): void {
  if (cond) return; // Early return if assertion passes

  console.assert(cond, "Assertion Failed: %s", msg);
  console.trace();

  if (typeof process !== "undefined" && process.versions.node) {
    process.exit(1);
  }
}

export function assertDefined<T>(val: T | undefined | null): asserts val is T {
  assert(val !== null && val !== undefined, "value must not be null");
}

export function isGeneratorFunction(fn: Function): boolean {
  const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
  const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
  return fn instanceof GeneratorFunction || fn instanceof AsyncGeneratorFunction;
}

export function isTaskRecord(obj: any): obj is TaskRecord {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof obj.id === "string" &&
    typeof obj.rootPromiseId === "string" &&
    typeof obj.counter === "number" &&
    typeof obj.timeout === "number" &&
    (obj.processId === undefined || typeof obj.processId === "string") &&
    (obj.createdOn === undefined || typeof obj.createdOn === "number") &&
    (obj.completedOn === undefined || typeof obj.completedOn === "number")
  );
}

export function isDurablePromiseRecord(obj: any): obj is DurablePromiseRecord {
  // TODO(dfarr): complete this type guard
  return typeof obj === "object" && obj !== null && typeof obj.id === "string" && typeof obj.state === "string";
}

export function isOptions(value: unknown): value is Options {
  return !!value && typeof value === "object" && RESONATE_OPTIONS in value;
}

export function splitArgsAndOpts(args: any[], defaults: Options): [any[], Options] {
  const opts = isOptions(args.at(-1)) ? args.pop() : {};
  return [args, { ...defaults, ...opts }];
}
