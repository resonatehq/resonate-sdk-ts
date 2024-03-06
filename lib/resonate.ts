import { IBucket } from "./core/bucket";
import { Bucket } from "./core/buckets/bucket";
import { IEncoder } from "./core/encoder";
import { JSONEncoder } from "./core/encoders/json";
import { ILogger } from "./core/logger";
import { Logger } from "./core/loggers/logger";
import { ResonateOptions, Options } from "./core/opts";
import { Retry } from "./core/retries/retry";
import { IRetry } from "./core/retry";
import { IScheduler } from "./core/scheduler";
import { IStore } from "./core/store";
import { LocalStore } from "./core/stores/local";
import { RemoteStore } from "./core/stores/remote";
import * as utils from "./core/utils";
import { ResonatePromise } from "./future";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type Func = (...args: any[]) => any;

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export abstract class ResonateBase {
  private readonly functions: Record<string, { func: Func; opts: Options }> = {};

  public readonly namespace: string;
  public readonly pid: string;
  public readonly separator: string;
  public readonly timeout: number;

  private readonly bucket: IBucket;
  private readonly encoder: IEncoder<unknown, string | undefined>;
  private readonly logger: ILogger;
  private readonly retry: IRetry;
  private readonly scheduler: IScheduler;
  private readonly store: IStore;

  constructor(
    scheduler: { new (resonate: ResonateBase, store: IStore): IScheduler },
    {
      bucket = new Bucket(),
      encoder = new JSONEncoder(),
      logger = new Logger(),
      namespace = "",
      pid = utils.randomId(),
      // retry = Retry.exponential(),
      retry = Retry.linear(0, 3),
      separator = "/",
      store = undefined,
      timeout = 10000, // 10s
      url = undefined,
    }: Partial<ResonateOptions> = {},
  ) {
    this.bucket = bucket;
    this.encoder = encoder;
    this.logger = logger;
    this.namespace = namespace;
    this.pid = pid;
    this.retry = retry;
    this.separator = separator;
    this.timeout = timeout;

    if (store) {
      this.store = store;
    } else if (url) {
      this.store = new RemoteStore(url, this.pid, this.logger);
    } else {
      this.store = new LocalStore(this.logger);
    }

    this.scheduler = new scheduler(this, this.store);
  }

  register(name: string, func: Func, opts: Partial<Options> = {}): (id: string, ...args: any) => ResonatePromise<any> {
    if (this.functions[name]) {
      throw new Error(`Function ${name} already registered`);
    }

    this.functions[name] = { func, opts: this.options(opts) };
    return (id: string, ...args: any[]) => this.run(name, id, ...args);
  }

  registerModule(module: Record<string, Func>, opts: Partial<Options> = {}) {
    for (const key in module) {
      this.register(key, module[key], opts);
    }
  }

  run<T>(name: string, id: string, ...args: any[]): ResonatePromise<T> {
    if (!this.functions[name]) {
      throw new Error(`Function ${name} not registered`);
    }

    id = (this.namespace === "" ? [name, id] : [this.namespace, name, id]).join(this.separator);

    const { func, opts } = this.functions[name];
    return this.scheduler.add(name, 1, id, func, args, opts);
  }

  recover() {
    // TODO
  }

  schedule() {
    // TODO
  }

  options({
    bucket = this.bucket,
    eid = utils.randomId(),
    encoder = this.encoder,
    // idempotencyKey = undefined,
    retry = this.retry,
    timeout = this.timeout,
  }: Partial<Options>): Options {
    return {
      __resonate: true,
      bucket,
      eid,
      encoder,
      // idempotencyKey,
      retry,
      timeout,
    };
  }
}
