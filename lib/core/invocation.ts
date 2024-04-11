import { Future } from "./future";
import { Options, PartialOptions, isOptions } from "./options";

/////////////////////////////////////////////////////////////////////
// Invocation
/////////////////////////////////////////////////////////////////////

export class Invocation<T> {
  future: Future<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;

  lock: boolean;
  eid: string;
  idempotencyKey: string;
  timeout: number;

  killed: boolean = false;

  createdAt: number = Date.now();
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
    public readonly name: string,
    public readonly id: string,
    public readonly headers: Record<string, string> | undefined,
    public readonly param: unknown,
    public readonly opts: Options,
    public readonly defaults: Options,
    timeout?: number,
    parent?: Invocation<any>,
  ) {
    // create a future and hold on to its resolvers
    const { future, resolve, reject } = Future.deferred<T>(this);
    this.future = future;
    this.resolve = resolve;
    this.reject = reject;

    this.root = parent?.root ?? this;
    this.parent = parent ?? null;

    // if the lock option is specified on the root, it will be propagated to children
    // otherwise, locking is enabled on the root invocation only
    this.lock = this.parent && this.opts.lock === undefined ? true : this.opts.lock ?? false;

    // get the execution id from either:
    // - a hard coded string
    // - a function that returns a string given the invocation id
    this.eid = typeof this.opts.eid === "function" ? this.opts.eid(this.id) : this.opts.eid;

    // get the idempotency key from either:
    // - a hard coded string
    // - a function that returns a string given the invocation id
    this.idempotencyKey =
      typeof this.opts.idempotencyKey === "function" ? this.opts.idempotencyKey(this.id) : this.opts.idempotencyKey;

    // calculate the timeout, which is either:
    // - a hard coded number, this is passed in when a durable promise already exists
    // - min of:
    //   - the current time plus the user provided relative time
    //   - the parent timeout
    this.timeout = timeout ?? Math.min(this.createdAt + this.opts.timeout, this.parent?.timeout ?? Infinity);
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

  split(args: [...any, PartialOptions?]): { args: any[]; opts: Options } {
    let opts = args[args.length - 1];

    // merge opts
    if (isOptions(opts)) {
      args = args.slice(0, -1);
      opts = { ...this.defaults, ...opts, tags: { ...this.defaults.tags, ...opts.tags } };
    } else {
      opts = this.defaults;
    }

    // if durable is false, disable lock
    opts.lock = opts.durable ? opts.lock : false;

    return { args, opts };
  }
}
