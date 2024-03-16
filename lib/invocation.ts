import { Options, PartialOptions, isPartialOptions } from "./core/opts";
import { Future } from "./future";

/////////////////////////////////////////////////////////////////////
// Invocation
/////////////////////////////////////////////////////////////////////

export class Invocation<T> {
  future: Future<T>;
  resolve: (v: T) => void;
  reject: (v?: unknown) => void;

  createdAt: number = Date.now();
  _killed: boolean = false;

  readonly root: Invocation<any>;
  readonly parent: Invocation<any> | null;
  readonly children: Invocation<any>[] = [];

  counter: number = 0;
  attempt: number = 0;

  awaited: Future<any>[] = [];
  blocked: Future<any> | null = null;

  constructor(
    public readonly id: string,
    public readonly idempotencyKey: string | undefined,
    public readonly opts: Options,
    parent?: Invocation<any>,
  ) {
    const { future, resolve, reject } = Future.deferred<T>(this);
    this.future = future;
    this.resolve = resolve;
    this.reject = reject;

    this.root = parent?.root ?? this;
    this.parent = parent ?? null;
  }

  get timeout(): number {
    return Math.min(this.createdAt + this.opts.timeout, this.parent?.timeout ?? Infinity);
  }

  get killed(): boolean {
    return this.root._killed;
  }

  kill(error: unknown) {
    this.root._killed = true;
    this.root.reject(error);
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

  addChild(child: Invocation<any>) {
    this.children.push(child);
  }

  split(args: [...any, PartialOptions?]): { args: any[]; opts: Options } {
    const opts = args[args.length - 1];
    const parentOpts = this.parent?.opts ?? this.root.opts;

    return isPartialOptions(opts)
      ? { args: args.slice(0, -1), opts: { ...parentOpts, ...opts } }
      : { args, opts: parentOpts };
  }

  // TODO
  // suspendable(): boolean;
  // suspend(): void | Promise<void>;
}
