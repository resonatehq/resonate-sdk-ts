import type { CompletePromiseRes, CreatePromiseRes, DurablePromiseRecord, Network } from "./network/network";
import * as util from "./util";

interface DurablePromiseProto {
  id: string;
  timeout: number;
  tags: Record<string, string>;
  fn?: string;
  args?: any[];
}

interface DurablePromise<T> {
  id: string;
  state: "pending" | "resolved" | "rejected" | "rejected_canceled" | "rejected_timedout";
  value?: T;
}

export class Handler {
  private promises: Map<string, DurablePromise<any>>;
  private network: Network;

  constructor(network: Network, initialPromises?: DurablePromise<any>[]) {
    this.network = network;
    this.promises = new Map();
    for (const p of initialPromises ?? []) {
      this.promises.set(p.id, p);
    }
  }

  public createPromise<T>(
    { id, timeout, tags, fn, args }: DurablePromiseProto,
    callback: (res: DurablePromise<T>) => void,
  ): void {
    const promise = this.promises.get(id);
    if (promise) {
      callback(promise);
      return;
    }

    this.network.send(
      {
        kind: "createPromise",
        id,
        iKey: id,
        timeout,
        tags,
        param: {
          fn,
          args,
        },
        strict: false,
      },
      (timeout, response) => {
        if (timeout) {
          console.log("got a timeout nope out of here, what does it mean?");
          return;
        }
        console.log(response);

        util.assert(response.kind === "createPromise");
        const { promise } = response as CreatePromiseRes;
        this.promises.set(promise.id, promise);
        callback(promise);
      },
    );
  }

  public resolvePromise<T>(id: string, value: T, callback: (res: DurablePromise<T>) => void): void {
    console.log({ id });
    const promise = this.promises.get(id);
    console.log(this.promises);
    util.assertDefined(promise);

    if (promise.state !== "pending") {
      callback(promise);
      return;
    }

    this.network.send(
      {
        kind: "completePromise",
        id,
        state: "resolved",
        value: value,
        iKey: id,
        strict: false,
      },
      (timeout, response) => {
        if (timeout) {
          console.log("got a timeout, nope out of here, what does it mean?");
        }
        console.log(response);
        util.assert(response.kind === "completePromise", "Response must be complete promise");
        const { promise } = response as CompletePromiseRes;
        this.promises.set(promise.id, promise);
        callback(promise);
      },
    );
  }
}
