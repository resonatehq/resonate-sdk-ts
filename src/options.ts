import type { RetryPolicy } from "./retries";
import * as util from "./util";

export const RESONATE_OPTIONS: unique symbol = Symbol("ResonateOptions");

export class Options {
  public readonly id: string | undefined;
  public readonly tags: Record<string, string>;
  public readonly target: string;
  public readonly timeout: number;
  public readonly version: number;
  public readonly retryPolicy: RetryPolicy | undefined;
  public readonly match: (target: string) => string;

  [RESONATE_OPTIONS] = true;

  constructor({
    match,
    id = undefined,
    tags = {},
    target = "default",
    timeout = 24 * util.HOUR,
    version = 0,
    retryPolicy = undefined,
  }: {
    match: (target: string) => string;
    id?: string;
    tags?: Record<string, string>;
    target?: string;
    timeout?: number;
    version?: number;
    retryPolicy?: RetryPolicy;
  }) {
    this.match = (target: string) => (util.isUrl(target) ? target : match(target));
    this.id = id;
    this.tags = tags;
    this.target = this.match(target);
    this.timeout = timeout;
    this.version = version;
    this.retryPolicy = retryPolicy;
  }

  public merge({
    id = undefined,
    tags = undefined,
    target = undefined,
    timeout = undefined,
    version = undefined,
    retryPolicy = undefined,
  }: {
    id?: string;
    tags?: Record<string, string>;
    target?: string;
    timeout?: number;
    version?: number;
    retryPolicy?: RetryPolicy;
  } = {}): Options {
    return new Options({
      match: this.match,
      id: id ?? this.id,
      tags: tags ?? this.tags,
      target: target ?? this.target,
      timeout: timeout ?? this.timeout,
      version: version ?? this.version,
      retryPolicy: retryPolicy ?? this.retryPolicy,
    });
  }
}
