import type { Codec } from "./codec.js";
import type { Data } from "./computation.js";
import exceptions from "./exceptions.js";
import type { DecoratedNetwork } from "./network/decorator.js";
import type { MessageSource } from "./network/network.js";
import { isResponse, isSuccess, type PromiseRecord } from "./network/types.js";
import { type Options, RESONATE_OPTIONS } from "./options.js";
import type { Effects } from "./types.js";

// time

export const MS = 1;
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

// assert

export function assert(cond: boolean, msg?: string): asserts cond {
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

export function isGeneratorFunction(func: Function): boolean {
  const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
  const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
  return func instanceof GeneratorFunction || func instanceof AsyncGeneratorFunction;
}

// guards

export function isValidData(data: unknown): data is Data {
  if (data === null || typeof data !== "object") return false;

  const d = data as any;

  // func must be a string
  if (typeof d.func !== "string") return false;

  // args must be an array
  if (!Array.isArray(d.args)) return false;

  // retry (if present) must be an object with string `type` and any `data`
  if (d.retry !== undefined) {
    if (d.retry === null || typeof d.retry !== "object" || typeof d.retry.type !== "string" || !("data" in d.retry)) {
      return false;
    }
  }

  // version (if present) must be a number
  if (d.version !== undefined && typeof d.version !== "number") {
    return false;
  }

  return true;
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

export function once<T extends () => any>(fn: T): T {
  let called = false;

  return (() => {
    assert(!called, "Function can only be called once");
    called = true;
    return fn();
  }) as T;
}

// effects

export function buildEffects(network: DecoratedNetwork, codec: Codec, preload: PromiseRecord[] = []): Effects {
  const cache = new Map<string, PromiseRecord>(preload.map((p) => [p.id, codec.decodePromise(p)]));

  return {
    promiseCreate: (req, done, func = "unknown", headers = {}, retryForever = false) => {
      const cached = cache.get(req.data.id);
      if (cached) {
        done({ kind: "value", value: cached });
        return;
      }

      try {
        req.data.param = codec.encode(req.data.param.data);
      } catch (e) {
        done({
          kind: "error",
          error: exceptions.ENCODING_ARGS_UNENCODEABLE(req.data.param.data?.func ?? func, e),
        });
        return;
      }

      network.send(
        req,
        (res) => {
          if (!isResponse(res)) {
            return done({ kind: "error", error: exceptions.UNEXPECTED_MSG(`${req.kind} response`, res) });
          }
          if (!isSuccess(res)) {
            return done({
              kind: "error",
              error: exceptions.SERVER_ERROR(res.data, true, {
                code: res.head.status,
                message: res.data,
              }),
            });
          }
          try {
            const promise = codec.decodePromise(res.data.promise);
            cache.set(promise.id, promise);
            done({ kind: "value", value: promise });
          } catch (e) {
            return done({ kind: "error", error: exceptions.UNEXPECTED_MSG(`${req.kind} response`, res) });
          }
        },
        headers,
        retryForever,
      );
    },

    promiseSettle: (req, done, func = "unknown") => {
      const cached = cache.get(req.data.id);
      if (cached && cached.state !== "pending") {
        done({ kind: "value", value: cached });
        return;
      }

      try {
        req.data.value = codec.encode(req.data.value.data);
      } catch (e) {
        done({ kind: "error", error: exceptions.ENCODING_RETV_UNENCODEABLE(func, e) });
        return;
      }

      network.send(req, (res) => {
        if (!isResponse(res)) {
          return done({ kind: "error", error: exceptions.UNEXPECTED_MSG(`${req.kind} response`, res) });
        }
        if (!isSuccess(res)) {
          return done({
            kind: "error",
            error: exceptions.SERVER_ERROR(res.data, true, {
              code: res.head.status,
              message: res.data,
            }),
          });
        }
        try {
          const promise = codec.decodePromise(res.data.promise);
          cache.set(promise.id, promise);
          done({ kind: "value", value: promise });
        } catch (e) {
          return done({ kind: "error", error: exceptions.UNEXPECTED_MSG(`${req.kind} response`, res) });
        }
      });
    },
  };
}
