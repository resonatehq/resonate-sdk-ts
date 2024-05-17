import { TFC, LFC, RFC } from "../calls";
import { IEncoder } from "../encoder";

type I = { fc: TFC | LFC | RFC; version: number };
type O = { id: string; headers: Record<string, string> | undefined; param: any };

export class CallEncoder implements IEncoder<I, O> {
  encode({ fc, version }: I): O {
    if (fc instanceof LFC) {
      return { id: "", headers: undefined, param: undefined };
    } else {
      return {
        id: fc.func,
        headers: undefined,
        param: { func: fc.func, args: fc.args, version },
      };
    }
  }

  decode({ id, param }: O): I {
    return {
      fc: new TFC(param.func, id, param.args),
      version: param.version,
    };
  }
}
