import { Options } from "./options";

export class TFC {
  public func: string;

  constructor(
    func: ((...args: any[]) => any) | string,
    public id: string,
    public args: any[] = [],
    public opts: Partial<Options> = {},
  ) {
    this.func = typeof func === "string" ? func : func.name;
  }
}

export class LFC {
  constructor(
    public func: (...args: any[]) => any,
    public args: any[] = [],
    public opts: Partial<Options> = {},
  ) {}
}

export class RFC {
  public func: string;

  constructor(
    func: ((...args: any[]) => any) | string,
    public args: any = undefined,
    public opts: Partial<Options> = {},
  ) {
    this.func = typeof func === "string" ? func : func.name;
  }
}
