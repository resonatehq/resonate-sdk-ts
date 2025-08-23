import { LocalNetwork } from "../dev/network";
import { AsyncHeartbeat } from "./heartbeat";
import type { Network } from "./network/network";
import { HttpNetwork } from "./network/remote";
import { ResonateInner } from "./resonate-inner";
import { type Func, type Options, type ParamsWithOptions, RESONATE_OPTIONS, type Return } from "./types";
import * as util from "./util";

export interface Handle<T> {
  id: string;
  result(): Promise<T>;
}

export interface ResonateFunc<F extends Func> {
  run: (id: string, ...args: ParamsWithOptions<F>) => Promise<Return<F>>;
  rpc: (id: string, ...args: ParamsWithOptions<F>) => Promise<Return<F>>;
  beginRun: (id: string, ...args: ParamsWithOptions<F>) => Promise<Handle<Return<F>>>;
  beginRpc: (id: string, ...args: ParamsWithOptions<F>) => Promise<Handle<Return<F>>>;
  options: (opts?: Partial<Options>) => Partial<Options> & { [RESONATE_OPTIONS]: true };
}

export class Resonate {
  private inner: ResonateInner;
  private network: Network;
  private group: string;
  private pid: string;
  private ttl: number;

  constructor(network: Network, config: { group: string; pid: string; ttl: number }) {
    this.network = network;
    this.group = config.group;
    this.pid = config.pid;
    this.ttl = config.ttl;
    this.inner = new ResonateInner(network, {
      ...config,
      heartbeat: new AsyncHeartbeat(config.pid, this.ttl / 2, network),
    });
  }

  /**
   * Create a local Resonate instance
   */
  static local(): Resonate {
    return new Resonate(new LocalNetwork(), {
      group: "default",
      pid: "default",
      ttl: 1 * util.MIN,
    });
  }

  /**
   * Create a remote Resonate instance
   */
  static remote(
    config: {
      host?: string;
      storePort?: string;
      messageSourcePort?: string;
      group?: string;
      pid?: string;
      ttl?: number;
    } = {},
  ): Resonate {
    const pid = config.pid ?? crypto.randomUUID();
    const group = config.group ?? "default";
    const ttl = config.ttl ?? 30 * util.SEC;

    const { host, storePort, messageSourcePort } = config;
    const network = new HttpNetwork({
      host: host ?? "http://localhost",
      storePort: storePort ?? "8001",
      msgSrcPort: messageSourcePort ?? "8002",
      pid: pid,
      group: group,
      timeout: 1 * util.MIN,
      headers: {},
    });
    return new Resonate(network, { pid, group, ttl });
  }

  /**
   * Register a function and returns a registered function
   */
  public register<F extends Func>(name: string, func: F): ResonateFunc<F>;
  public register<F extends Func>(func: F): ResonateFunc<F>;
  public register<F extends Func>(nameOrFunc: string | F, maybeFunc?: F): ResonateFunc<F> {
    const name = typeof nameOrFunc === "string" ? nameOrFunc : nameOrFunc.name;
    const func = typeof nameOrFunc === "string" ? maybeFunc! : nameOrFunc;

    this.inner.register(name ?? func.name, func);

    return {
      run: (id: string, ...args: ParamsWithOptions<F>): Promise<Return<F>> => this.run(id, func, ...args),
      rpc: (id: string, ...args: ParamsWithOptions<F>): Promise<Return<F>> => this.rpc(id, func, ...args),
      beginRun: (id: string, ...args: ParamsWithOptions<F>): Promise<Handle<Return<F>>> =>
        this.beginRun(id, func, ...args),
      beginRpc: (id: string, ...args: ParamsWithOptions<F>): Promise<Handle<Return<F>>> =>
        this.beginRpc(id, func, ...args),
      options: this.options,
    };
  }

  /**
   * Invoke a function and return a value
   */
  public async run<F extends Func>(id: string, func: F, ...args: ParamsWithOptions<F>): Promise<Return<F>>;
  public async run<T>(id: string, name: string, ...args: any[]): Promise<T>;
  public async run<T>(id: string, funcOrName: Func | string, ...args: any[]): Promise<T>;
  public async run(id: string, funcOrName: Func | string, ...args: any[]): Promise<any> {
    return (await this.beginRun(id, funcOrName, ...args)).result();
  }

  /**
   * Invoke a function and return a promise
   */
  public async beginRun<F extends Func>(id: string, func: F, ...args: ParamsWithOptions<F>): Promise<Handle<Return<F>>>;
  public async beginRun<T>(id: string, func: string, ...args: any[]): Promise<Handle<T>>;
  public async beginRun(id: string, funcOrName: Func | string, ...args: any[]): Promise<Handle<any>>;
  public async beginRun(id: string, funcOrName: Func | string, ...argsWithOpts: any[]): Promise<Handle<any>> {
    const registered = this.inner.registry.get(funcOrName); // TODO(avillega): should the register be owned by Resonate?
    if (!registered) {
      throw new Error(`${funcOrName} does not exist`);
    }

    const [args, opts] = util.splitArgsAndOpts(argsWithOpts, this.options());

    // p1 is resolved with a handle
    const handle = Promise.withResolvers<Handle<any>>();

    // p2 is resolved with the value
    const result = Promise.withResolvers<any>();

    const promiseHandler = this.inner.process({
      kind: "run",
      id: id,
      req: {
        kind: "createPromiseAndTask",
        promise: {
          id: id,
          timeout: opts.timeout + Date.now(),
          param: { func: registered.name, args },
          tags: {
            "resonate:invoke": `poll://any@${this.group}/${this.pid}`,
            "resonate:scope": "global",
            ...opts.tags,
          }, // TODO(avillega): use the real anycast address or change the server to not require `poll://`
        },
        task: {
          processId: this.pid,
          ttl: this.ttl,
        },
        iKey: id,
        strict: false,
      },
    });

    // listen for created and resolve p1 with a handle
    promiseHandler.addEventListener("created", (promise) => {
      handle.resolve({
        id: promise.id,
        result: () => new Promise((resolve, reject) => result.promise.then(resolve, reject)),
      });
    });

    // listen for completed and resolve p2 with the value
    promiseHandler.addEventListener("completed", (promise) => {
      util.assert(promise.state !== "pending", "promise must be completed");

      if (promise.state === "resolved") {
        result.resolve(promise.value);
      } else if (promise.state === "rejected") {
        result.reject(promise.value);
      } else if (promise.state === "rejected_canceled") {
        result.reject(new Error("Promise canceled"));
      } else if (promise.state === "rejected_timedout") {
        result.reject(new Error("Promise timedout"));
      }
    });

    return handle.promise;
  }

  /**
   * Invoke a remote function and return a value
   */
  public async rpc<F extends Func>(id: string, func: F, ...args: ParamsWithOptions<F>): Promise<Return<F>>;
  public async rpc<T>(id: string, name: string, ...args: any[]): Promise<T>;
  public async rpc<T>(id: string, funcOrName: Func | string, ...args: any[]): Promise<T>;
  public async rpc(id: string, funcOrName: Func | string, ...args: any[]): Promise<any> {
    return (await this.beginRpc(id, funcOrName, ...args)).result();
  }

  /**
   * Invoke a remote function and return a promise
   */
  public async beginRpc<F extends Func>(id: string, func: F, ...args: ParamsWithOptions<F>): Promise<Handle<Return<F>>>;
  public async beginRpc<T>(id: string, func: string, ...args: any[]): Promise<Handle<T>>;
  public async beginRpc(id: string, funcOrName: Func | string, ...args: any[]): Promise<Handle<any>>;
  public async beginRpc(id: string, funcOrName: Func | string, ...argsWithOpts: any[]): Promise<Handle<any>> {
    let name: string;
    if (typeof funcOrName === "string") {
      name = funcOrName;
    } else {
      const registered = this.inner.registry.get(funcOrName);
      if (!registered) {
        throw new Error(`${funcOrName} is not registered`);
      }
      name = registered.name;
    }

    // TODO(dfarr): use the all options
    const [args, opts] = util.splitArgsAndOpts(argsWithOpts, this.options());

    // p1 is resolved with a handle
    const handle = Promise.withResolvers<Handle<any>>();

    // p2 is resolved with the value
    const result = Promise.withResolvers<any>();

    const promiseHandler = this.inner.process({
      kind: "rpc",
      id: id,
      req: {
        kind: "createPromise",
        id: id,
        timeout: opts.timeout + Date.now(),
        param: { func: name, args },
        tags: { "resonate:invoke": opts.target, "resonate:scope": "global", ...opts.tags },
        iKey: id,
        strict: false,
      },
    });

    // listen for created and resolve p1 with a handle
    promiseHandler.addEventListener("created", (promise) => {
      handle.resolve({
        id: promise.id,
        result: () =>
          new Promise((resolve, reject) => {
            // subscribe lazily, no need to await
            promiseHandler.subscribe();
            return result.promise.then(resolve, reject);
          }),
      });
    });

    // listen for completed and resolve p2 with the value
    promiseHandler.addEventListener("completed", (promise) => {
      util.assert(promise.state !== "pending", "promise must be completed");

      if (promise.state === "resolved") {
        result.resolve(promise.value);
      } else if (promise.state === "rejected") {
        result.reject(promise.value);
      } else if (promise.state === "rejected_canceled") {
        result.reject(new Error("Promise canceled"));
      } else if (promise.state === "rejected_timedout") {
        result.reject(new Error("Promise timedout"));
      }
    });

    return handle.promise;
  }

  public options(opts: Partial<Options> = {}): Options & { [RESONATE_OPTIONS]: true } {
    return {
      id: "",
      target: `poll://any@${this.group}`,
      timeout: 24 * util.HOUR,
      tags: {},
      ...opts,
      [RESONATE_OPTIONS]: true,
    };
  }

  public stop() {
    this.inner.stop();
  }
}
