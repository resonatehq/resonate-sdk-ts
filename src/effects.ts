import type { ResonateError } from "./exceptions.js";
import type { PromiseCreateReq, PromiseRecord, PromiseSettleReq } from "./network/types.js";
import type { Result } from "./types.js";

export type Effects = {
  promiseCreate: (
    req: PromiseCreateReq,
    done: (res: Result<PromiseRecord, ResonateError>) => void,
    func?: string,
    headers?: Record<string, string>,
    retryForever?: boolean,
  ) => void;

  promiseSettle: (
    req: PromiseSettleReq,
    done: (res: Result<PromiseRecord, ResonateError>) => void,
    func?: string,
  ) => void;
};
