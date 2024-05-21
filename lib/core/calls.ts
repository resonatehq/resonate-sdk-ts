import { Options } from "./options";

export class TFC<T = any, A extends any[] = any[]> {
  public func: string;

  constructor(
    func: ((...args: [any, ...A]) => T) | string,
    public id: string,
    public args: A,
    public opts: Partial<Options> = {},
  ) {
    this.func = typeof func === "string" ? func : func.name;
  }
}

export class LFC<T = any, A extends any[] = any[]> {
  constructor(
    public func: (...args: [any, ...A]) => T,
    public args: A,
    public opts: Partial<Options> = {},
  ) {}
}

export class RFC<T = any, A extends any[] = any[]> {
  public func: string;

  constructor(
    func: ((...args: [any, ...A]) => T) | string,
    public args: A,
    public opts: Partial<Options> = {},
  ) {
    this.func = typeof func === "string" ? func : func.name;
  }
}
