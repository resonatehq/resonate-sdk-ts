import { IStorage } from "../storage";
import { DurablePromise } from "../promise";
import { IEncoder } from "../encoder";
import { PromiseEncoder } from "../encoders/promise";
import { CombinedEncoder } from "../encoders/combined";
import { JSONEncoder } from "../encoders/json";

export class MemoryStorage implements IStorage {
  private promises: Record<string, string> = {};

  constructor(
    private encoder: IEncoder<DurablePromise, string> = new CombinedEncoder(new PromiseEncoder(), new JSONEncoder()),
  ) {}

  async rmw<P extends DurablePromise | undefined>(
    id: string,
    f: (promise: DurablePromise | undefined) => P,
  ): Promise<P> {
    let initial;
    if (id in this.promises) {
      initial = this.encoder.decode(this.promises[id]);
    }

    const promise = f(initial);
    if (promise) {
      this.promises[id] = this.encoder.encode(promise);
    }

    return promise;
  }
}
