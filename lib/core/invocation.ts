import { LFC, TFC, RFC } from "./calls";
import { IEncoder } from "./encoder";
import { Future } from "./future";
import { Options } from "./options";
import { IRetry } from "./retry";

/////////////////////////////////////////////////////////////////////
// Invocation
/////////////////////////////////////////////////////////////////////

export class Invocation<T> {
  future: Future<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;

  // opts
  durable: boolean;
  eid: string;
  encoder: IEncoder<unknown, string | undefined>;
  idempotencyKey: string;
  lock: boolean;
  poll: number;
  retry: IRetry;
  tags: Record<string, string>;
  timeout: number;
  version: number;

  // state
  killed: boolean = false;

  // metadata
  createdOn: number = Date.now();
  counter: number = 0;
  attempt: number = 0;
  awaited: Future<any>[] = [];
  blocked: Future<any> | null = null;

  readonly root: Invocation<any>;
  readonly parent: Invocation<any> | null;
  readonly children: Invocation<any>[] = [];

  /**
   * Represents a Resonate function invocation.
   *
   * @constructor
   * @param id - A unique id for this invocation.
   * @param idempotencyKey - An idempotency key used to deduplicate invocations.
   * @param opts - The invocation options.
   * @param parent - The parent invocation.
   */
  constructor(
    public readonly id: string,
    public readonly fc: TFC | LFC | RFC,
    public readonly headers: Record<string, string> | undefined,
    public readonly param: unknown,
    public readonly defaults: Options,
    parent?: Invocation<any>,
  ) {
    // create a future and hold on to its resolvers
    const { future, resolve, reject } = Future.deferred<T>(this);
    this.future = future;
    this.resolve = resolve;
    this.reject = reject;

    this.root = parent?.root ?? this;
    this.parent = parent ?? null;

    // merge defaults and overrides
    const opts = { ...defaults, ...fc.opts };

    this.durable = opts.durable;

    // get the execution id from either:
    // - a hard coded string
    // - a function that returns a string given the invocation id
    this.eid = typeof opts.eid === "function" ? opts.eid(this.id) : opts.eid;

    this.encoder = opts.encoder;

    // get the idempotency key from either:
    // - a hard coded string
    // - a function that returns a string given the invocation id
    this.idempotencyKey =
      typeof opts.idempotencyKey === "function" ? opts.idempotencyKey(this.id) : opts.idempotencyKey;

    // if undefined lock is:
    // - true for TFC
    // - false for LFC and RFC
    this.lock = opts.lock ?? fc instanceof TFC;

    this.poll = opts.poll;

    this.retry = opts.retry;

    // tags are merged
    this.tags = { ...this.defaults.tags, ...opts.tags };

    // if the function is a TFC, add the "resonate:invocation" tag
    if (fc instanceof TFC) {
      this.tags["resonate:invocation"] = "true";
    }

    // the timeout is the minimum of:
    // - the current time plus the user provided relative time
    // - the parent timeout
    this.timeout = Math.min(this.createdOn + opts.timeout, this.parent?.timeout ?? Infinity);

    // version cannot be overridden
    this.version = this.defaults.version;
  }

  get opts(): Options {
    return {
      __resonate: true,
      durable: this.durable,
      eid: this.eid,
      encoder: this.encoder,
      idempotencyKey: this.idempotencyKey,
      lock: this.lock,
      poll: this.poll,
      retry: this.retry,
      tags: this.tags,
      timeout: this.timeout,
      version: this.version,
    };
  }

  addChild(child: Invocation<any>) {
    this.children.push(child);
  }

  await(future: Future<any>) {
    this.awaited.push(future);
  }

  block(future: Future<any>) {
    this.blocked = future;
  }

  unblock() {
    this.blocked = null;
  }
}
