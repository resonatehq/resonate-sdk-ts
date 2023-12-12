import { IEncoder } from "../encoder";
import { DurablePromise, isDurablePromise } from "../promise";
import { Base64Encoder } from "./base64";

export class PromiseEncoder implements IEncoder<DurablePromise, string> {
  constructor(
    private paramEncoder: IEncoder<string, any> = new Base64Encoder(),
    private valueEncoder: IEncoder<string, any> = new Base64Encoder(),
  ) {}

  match(data: unknown): data is DurablePromise {
    return isDurablePromise(data);
  }

  encode(promise: DurablePromise): any {
    if (promise.param?.data) {
      promise.param.data = this.paramEncoder.encode(promise.param.data);
    }

    if (promise.value?.data) {
      promise.value.data = this.valueEncoder.encode(promise.value.data);
    }

    return promise;
  }

  decode(promise: any): DurablePromise {
    if (promise.param?.data) {
      promise.param.data = this.paramEncoder.decode(promise.param.data);
    }

    if (promise.value?.data) {
      promise.value.data = this.valueEncoder.decode(promise.value.data);
    }

    return promise;
  }
}
