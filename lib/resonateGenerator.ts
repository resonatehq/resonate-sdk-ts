import { IStore } from "./core/store";
import { LocalStore } from "./core/stores/local";

import { Context, Scheduler } from "./generator";

// interface IScheduler {
//     add(id: string, func: (ctx: Context, ...args: any[]) => any, ...args: any[]): Promise<any>;
// }

class Resonate {
  private readonly functions: Record<string, any> = {};

  constructor(
    private store: IStore,
    private scheduler: Scheduler,
  ) {}

  register<T, A extends any[] = any[]>(name: string, func: (ctx: Context, ...args: A) => Generator<any, T>) {
    this.functions[name] = func;
    return (id: string, ...args: A) => this.run<T, A>(name, id, ...args);
  }

  run<T, A extends any[] = any[]>(name: string, id: string, ...args: A): Promise<T> {
    const func = this.functions[name];
    return this.scheduler.add(`${name}/${id}`, func, args);
  }

  recover() {
    // TODO
  }
}

const store = new LocalStore();
const scheduler = new Scheduler(store);

const resonate = new Resonate(store, scheduler);

function* foo(ctx: Context, name: string) {
  return `Hello, ${name}!`;
}

const f = resonate.register("foo", foo);

async function main() {
  const r1 = await resonate.run<string>("foo", "a", "David");
  console.log("*************");
  console.log(r1);
  console.log("*************");

  const r2 = await f("b", "David");
  console.log("*************");
  console.log(r2);
  console.log("*************");
}

main();
