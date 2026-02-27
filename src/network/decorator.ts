import type { MessageSource, Network } from "./network.js";
import { isResponse, type Request, type Response } from "./types.js";

export class DecoratedNetwork implements Network<Request, Response> {
  private network: Network<string, string>;
  readonly getMessageSource: (() => MessageSource) | undefined;

  constructor(network: Network<string, string>) {
    this.network = network;
  }

  start(): void {
    this.network.start();
  }

  stop(): void {
    this.network.stop();
  }

  send<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
    headers?: { [key: string]: string },
    retryForever?: boolean,
  ): void {
    this.network.send(
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
