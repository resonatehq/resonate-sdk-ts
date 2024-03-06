import { ResonatePromise } from "../future";
import { Options } from "./opts";

export interface IScheduler {
  add(
    name: string,
    version: number,
    id: string,
    func: (...args: any[]) => any,
    args: any[],
    opts: Options,
  ): ResonatePromise<any>;
}
