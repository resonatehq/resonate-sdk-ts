import { ResonatePromise } from "./future";
import { IStore } from "./core/store";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type Func = (...args: any[]) => unknown;

type Params<F extends Func> = F extends (ctx: any, ...args: infer P) => any ? P : never;

type Return<F extends Func, G extends Func> = F extends (...args: any[]) => Generator
  ? G extends (...args: any[]) => Generator<unknown, infer T>
    ? T
    : never
  : Awaited<ReturnType<G>>;

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

interface IScheduler<F extends Func> {
  add(id: string, func: F, args: any[]): ResonatePromise<any>;
}

export abstract class ResonateBase<F extends Func> {
  private readonly functions: Record<string, F> = {};

  constructor(
    private store: IStore,
    private scheduler: IScheduler<F>,
  ) {}

  register<G extends F>(name: string, func: G): (id: string, ...args: Params<G>) => ResonatePromise<Return<F, G>> {
    this.functions[name] = func;
    return (id: string, ...args: Params<F>) => this.run(name, id, ...args);
  }

  run<T>(name: string, id: string, ...args: any[]): ResonatePromise<T> {
    const func = this.functions[name];
    return this.scheduler.add(`${name}/${id}`, func, args);
  }

  recover() {
    // TODO
  }
}
