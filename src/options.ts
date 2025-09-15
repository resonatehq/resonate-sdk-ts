import { Exponential, Never, type RetryPolicy } from "./retries";
import * as util from "./util";

export const RESONATE_OPTIONS: unique symbol = Symbol("ResonateOptions");

export class Options {
  public readonly id: string;
  public readonly tags: Record<string, string>;
  public readonly target: string;
  public readonly timeout: number;
  public readonly funcRetryPolicy: RetryPolicy;
  public readonly genRetryPolicy: RetryPolicy;

  [RESONATE_OPTIONS] = true;

  constructor({
    id = "",
    tags = {},
    target = "default",
    timeout = 24 * util.HOUR,
    funcRetryPolicy = new Exponential(),
    genRetryPolicy = new Never(),
  }: {
    id?: string;
    tags?: Record<string, string>;
    target?: string;
    timeout?: number;
    funcRetryPolicy?: RetryPolicy;
    genRetryPolicy?: RetryPolicy;
  }) {
    this.id = id;
    this.tags = tags;
    this.target = this.match(target);
    this.timeout = timeout;
    this.funcRetryPolicy = funcRetryPolicy;
    this.genRetryPolicy = genRetryPolicy;
  }

  private match(target: string): string {
    // can be refactored to be configurable
    return util.isUrl(target) ? target : `poll://any@${target}`;
  }
}
