import type { MessageSource, Network } from "./network.js";
import { isResponse, type Request, type Response } from "./types.js";

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
        const parsed: unknown = JSON.parse(resStr);
        if (!isResponse(parsed) || parsed.kind !== req.kind) {
          throw new Error(`Unexpected response for kind "${req.kind}": ${resStr}`);
        }
        callback(parsed as Extract<Response, { kind: K }>);
      },
      headers,
      retryForever,
    );
  }
}

export type { MessageSource };
