import type { MessageSource } from "./network/network";
import { type Options, RESONATE_OPTIONS } from "./options";

// time

export const MS = 1;
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

export function isGeneratorFunction(func: Function): boolean {
  const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
  const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
  return func instanceof GeneratorFunction || func instanceof AsyncGeneratorFunction;
}

export function isOptions(obj: unknown): obj is Options {
  return typeof obj === "object" && obj !== null && RESONATE_OPTIONS in obj;
}

export function isMessageSource(v: unknown): v is MessageSource {
  return typeof v === "object" && v !== null && "recv" in v && typeof (v as any).recv === "function";
}

// helpers

export function splitArgsAndOpts(args: any[], defaults: Options): [any[], Options] {
  const opts = isOptions(args.at(-1)) ? args.pop() : {};
  return [args, { ...defaults, ...opts }];
}

export function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

export function base64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return btoa(String.fromCharCode(...bytes));
}

export function base64Decode(str: string): string {
  const bytes = Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const jsonStr = new TextDecoder().decode(bytes);
  return jsonStr;
}

export function semverLessThan(a: string, b: string): boolean {
  const [aMajor, aMinor, aPatch] = a.split(".").map((x) => Number.parseInt(x, 10));
  const [bMajor, bMinor, bPatch] = b.split(".").map((x) => Number.parseInt(x, 10));

  if (aMajor !== bMajor) return aMajor < bMajor;
  if (aMinor !== bMinor) return aMinor < bMinor;
  return aPatch < bPatch;
}

export function getCallerInfo(): string {
  const err = new Error();
  if (!err.stack) return "";

  const stack = err.stack.split("\n");

  // stack[0] is "Error"
  // stack[1] is this function (getCallerInfo)
  // stack[2] is the caller of this function
  // stack[3] is the info we want
  const callerLine = stack?.[3];

  return callerLine.trim();
}
