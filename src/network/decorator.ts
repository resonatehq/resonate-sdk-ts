import type { MessageSource, Network } from "./network.js";
import type { Request, Response } from "./types.js";

export class DecoratedNetwork<T extends Network<string, string>> implements Network<Request, Response> {
  readonly inner: T;

  constructor(network: T) {
    this.inner = network;
  }

  start(): void {
    this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  send<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
    headers?: { [key: string]: string },
    retryForever?: boolean,
  ): void {
    this.inner.send(
      JSON.stringify(req),
      (resStr) => {
        callback(JSON.parse(resStr));
      },
      headers,
      retryForever,
    );
  }
}

export type { MessageSource };
