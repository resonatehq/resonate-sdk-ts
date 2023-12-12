import { IEncoder } from "../encoder";

export class CombinedEncoder<A, B, C> implements IEncoder<A, C> {
  constructor(
    private encoder1: IEncoder<A, B>,
    private encoder2: IEncoder<B, C>,
  ) {}

  match(data: unknown): data is A {
    return this.encoder1.match(data);
  }

  encode(data: A): C {
    return this.encoder2.encode(this.encoder1.encode(data));
  }

  decode(data: C): A {
    return this.encoder1.decode(this.encoder2.decode(data));
  }
}
