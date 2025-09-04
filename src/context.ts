import type { Clock } from "./clock";
import type { CreatePromiseReq } from "./network/network";
import { type Func, type Options, type ParamsWithOptions, RESONATE_OPTIONS, type Result, type Return } from "./types";
import * as util from "./util";

export class LFI<T> implements Iterable<LFI<T>> {
  public func: Func;
  public args: any[];
  public createReq: CreatePromiseReq;

  constructor(func: Func, args: any[], createReq: CreatePromiseReq) {
    this.func = func;
    this.args = args;
    this.createReq = createReq;
  }

  *[Symbol.iterator](): Generator<LFI<T>, Future<T>, any> {
    const v = yield this;
    util.assert(v instanceof Future, "expected future");
    return v as Future<T>;
  }
}

export class LFC<T> implements Iterable<LFC<T>> {
  public func: Func;
  public args: any[];
  public createReq: CreatePromiseReq;

  constructor(func: Func, args: any[], createReq: CreatePromiseReq) {
    this.func = func;
    this.args = args;
    this.createReq = createReq;
  }

  *[Symbol.iterator](): Generator<LFC<T>, T, any> {
    const v = yield this;
    util.assert(!(v instanceof Future), "expected value");
    return v as T;
  }
}

export class RFI<T> implements Iterable<RFI<T>> {
  public createReq: CreatePromiseReq;
  public mode: "attached" | "detached";

  constructor(createReq: CreatePromiseReq, mode: "attached" | "detached" = "attached") {
    this.createReq = createReq;
    this.mode = mode;
  }

  *[Symbol.iterator](): Generator<RFI<T>, Future<T>, any> {
    const v = yield this;
    util.assert(v instanceof Future, "expected future");
    return v as Future<T>;
  }
}

export class RFC<T> implements Iterable<RFC<T>> {
  public createReq: CreatePromiseReq;
  public mode = "attached" as const;

  constructor(createReq: CreatePromiseReq) {
    this.createReq = createReq;
  }

  *[Symbol.iterator](): Generator<RFC<T>, T, any> {
    const v = yield this;
    util.assert(!(v instanceof Future), "expected value");
    return v as T;
  }
}

export class Future<T> implements Iterable<Future<T>> {
  private readonly value?: Result<T>;
  public readonly state: "pending" | "completed";
  private mode: "attached" | "detached";

  constructor(
    public id: string,
    state: "pending" | "completed",
    value?: Result<T>,
    mode: "attached" | "detached" = "attached",
  ) {
    this.value = value;
    this.state = state;
    this.mode = mode;
  }

  getValue() {
    if (!this.value) {
      throw new Error("Future is not ready");
    }

    if (this.value.success) {
      return this.value.value;
    }
    throw this.value.error; // Should be unreachble
  }

  *[Symbol.iterator](): Generator<Future<T>, T, undefined> {
    yield this;
    util.assertDefined(this.value);
    util.assert(this.value.success, "The value must be and ok result at this point.");
    return this.getValue();
  }
}

export interface Context {
  readonly id: string;
  readonly timeout: number;

  // core four
  lfi<F extends Func>(func: F, ...args: ParamsWithOptions<F>): LFI<Return<F>>;
  lfc<F extends Func>(func: F, ...args: ParamsWithOptions<F>): LFC<Return<F>>;
  rfi<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFI<Return<F>>;
  rfi<T>(func: string, ...args: any[]): RFI<T>;
  rfi(func: Func | string, ...args: any[]): RFI<any>;
  rfc<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFC<Return<F>>;
  rfc<T>(func: string, ...args: any[]): RFC<T>;
  rfc(func: Func | string, ...args: any[]): RFC<any>;

  // beginRun (lfi alias)
  beginRun<F extends Func>(func: F, ...args: ParamsWithOptions<F>): LFI<Return<F>>;

  // run (lfc alias)
  run<F extends Func>(func: F, ...args: ParamsWithOptions<F>): LFC<Return<F>>;

  // beginRpc (rfi alias)
  beginRpc<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFI<Return<F>>;
  beginRpc<T>(func: string, ...args: any[]): RFI<T>;
  beginRpc(func: Func | string, ...args: any[]): RFI<any>;

  // rpc (rfc alias)
  rpc<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFC<Return<F>>;
  rpc<T>(func: string, ...args: any[]): RFC<T>;
  rpc(func: Func | string, ...args: any[]): RFC<any>;

  // sleep
  sleep(ms: number): RFC<void>;

  // promise
  promise<T>({
    id,
    timeout,
    data,
    tags,
  }: { id?: string; timeout?: number; data?: any; tags?: Record<string, string> }): RFI<T>;

  // detached
  detached<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFI<Return<F>>;
  detached<T>(func: string, ...args: any[]): RFI<T>;
  detached(func: Func | string, ...args: any[]): RFI<any>;

  // getDependency
  getDependency(key: string): any | undefined;

  // options
  options(opts: Partial<Options>): Options & { [RESONATE_OPTIONS]: true };

  // date
  date: Date;

  // random
  random: Random;
}

export interface Date {
  now(): LFC<number>;
}

export interface Random {
  random(): LFC<number>;
}

export class InnerContext implements Context {
  readonly id: string;
  readonly timeout: number;
  readonly date: Date;
  readonly random: Random;

  private rId: string;
  private pId: string;
  private clock: Clock;
  private dependencies: Map<string, any>;
  private seq = 0;

  run = this.lfc.bind(this);
  rpc = this.rfc.bind(this);
  beginRun = this.lfi.bind(this);
  beginRpc = this.rfi.bind(this);

  // TODO(avillega): set the parent timeout to be used to calculate the actual timeout for the createReq
  private constructor(
    id: string,
    rId: string,
    pId: string,
    timeout: number,
    clock: Clock,
    dependencies: Map<string, any>,
  ) {
    this.id = id;
    this.rId = rId;
    this.pId = pId;
    this.timeout = timeout;
    this.clock = clock;
    this.dependencies = dependencies;

    this.date = this.getDependency("resonate:date") ?? {
      now: () => this.lfc(Date.now),
    };

    this.random = this.getDependency("resonate:random") ?? {
      random: () => this.lfc(Math.random),
    };
  }

  static root(id: string, timeout: number, clock: Clock, dependencies: Map<string, any>) {
    return new InnerContext(id, id, id, timeout, clock, dependencies);
  }

  child(id: string, timeout: number) {
    return new InnerContext(id, this.rId, this.id, timeout, this.clock, this.dependencies);
  }

  lfi<F extends Func>(func: F, ...args: ParamsWithOptions<F>): LFI<Return<F>> {
    const [argu, opts] = util.splitArgsAndOpts(args, this.options());
    return new LFI(func, argu, this.localCreateReq(opts));
  }

  lfc<F extends Func>(func: F, ...args: ParamsWithOptions<F>): LFC<Return<F>> {
    const [argu, opts] = util.splitArgsAndOpts(args, this.options());
    return new LFC(func, argu, this.localCreateReq(opts));
  }

  rfi<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFI<Return<F>>;
  rfi<T>(func: string, ...args: any[]): RFI<T>;
  rfi(func: Func | string, ...args: any[]): RFI<any> {
    if (typeof func === "function") {
      throw new Error("not implemented");
    }
    const [argu, opts] = util.splitArgsAndOpts(args, this.options());
    return new RFI(this.remoteCreateReq(func, argu, opts));
  }

  rfc<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFC<Return<F>>;
  rfc<T>(func: string, ...args: any[]): RFC<T>;
  rfc(func: Func | string, ...args: any[]): RFC<any> {
    if (typeof func === "function") {
      throw new Error("not implemented");
    }
    const [argu, opts] = util.splitArgsAndOpts(args, this.options());
    return new RFC(this.remoteCreateReq(func, argu, opts));
  }

  promise<T>({
    id,
    timeout,
    data,
    tags,
  }: { id?: string; timeout?: number; data?: any; tags?: Record<string, string> }): RFI<T> {
    return new RFI(this.latentCreateOpts(id, timeout, data, tags));
  }

  sleep(ms: number): RFC<void> {
    return new RFC(this.sleepCreateOpts(this.options({ timeout: ms })));
  }

  detached<F extends Func>(func: F, ...args: ParamsWithOptions<F>): RFI<Return<F>>;
  detached<T>(func: string, ...args: any[]): RFI<T>;
  detached(func: Func | string, ...args: any[]): RFI<any> {
    if (typeof func === "function") {
      throw new Error("not implemented");
    }
    const [argu, opts] = util.splitArgsAndOpts(args, this.options());
    return new RFI(this.remoteCreateReq(func, argu, opts, Number.MAX_SAFE_INTEGER), "detached");
  }

  getDependency(key: string): any | undefined {
    return this.dependencies.get(key);
  }

  options(opts: Partial<Options> = {}): Options & { [RESONATE_OPTIONS]: true } {
    return {
      id: this.seqid(),
      target: "poll://any@default",
      timeout: 24 * util.HOUR,
      tags: {},
      ...opts,
      [RESONATE_OPTIONS]: true,
    };
  }

  localCreateReq(opts: Options): CreatePromiseReq {
    const tags = {
      "resonate:scope": "local",
      "resonate:root": this.rId,
      "resonate:parent": this.pId,
      ...opts.tags,
    };

    // timeout cannot be greater than parent timeout
    const timeout = Math.min(this.clock.now() + opts.timeout, this.timeout);

    return {
      kind: "createPromise",
      id: opts.id,
      timeout: timeout,
      param: {},
      tags,
      iKey: opts.id,
      strict: false,
    };
  }

  remoteCreateReq(func: string, args: any[], opts: Options, maxTimeout = this.timeout): CreatePromiseReq {
    const tags = {
      "resonate:scope": "global",
      "resonate:invoke": opts.target,
      "resonate:root": this.rId,
      "resonate:parent": this.pId,
      ...opts.tags,
    };

    // timeout cannot be greater than parent timeout (unless detached)
    const timeout = Math.min(this.clock.now() + opts.timeout, maxTimeout);

    return {
      kind: "createPromise",
      id: opts.id,
      timeout: timeout,
      tags,
      param: {
        func,
        args,
      },
      iKey: opts.id,
      strict: false,
    };
  }

  latentCreateOpts(id?: string, timeout?: number, data?: any, tags?: Record<string, string>): CreatePromiseReq {
    const cTags = {
      "resonate:scope": "global",
      "resonate:root": this.rId,
      "resonate:parent": this.pId,
      ...tags,
    };

    const cId = id ?? this.seqid();

    // timeout cannot be greater than parent timeout
    const cTimeout = Math.min(this.clock.now() + (timeout ?? 24 * util.HOUR), this.timeout);

    return {
      kind: "createPromise",
      id: cId,
      timeout: cTimeout,
      param: data,
      tags: cTags,
      iKey: cId,
      strict: false,
    };
  }

  sleepCreateOpts(opts: Options): CreatePromiseReq {
    const tags = {
      "resonate:scope": "global",
      "resonate:root": this.rId,
      "resonate:parent": this.pId,
      "resonate:timeout": "true",
      ...opts.tags,
    };

    // timeout cannot be greater than parent timeout
    const timeout = Math.min(this.clock.now() + opts.timeout, this.timeout);

    return {
      kind: "createPromise",
      id: opts.id,
      timeout: timeout,
      param: {},
      tags,
      iKey: opts.id,
      strict: false,
    };
  }

  seqid(): string {
    return `${this.id}.${this.seq++}`;
  }
}
