import exceptions from "../exceptions.js";
import type { MessageSource, Network } from "./network.js";
import { isRequest, isResponse, type Request, type Response } from "./types.js";

export class DecoratedNetwork<T extends Network<string, string>> implements Network<Request, Response> {
  private inner: T;

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
    headers: { [key: string]: string } = {},
    retryForever: boolean = false,
  ): void {
    if (!isRequest(req)) {
      throw exceptions.UNEXPECTED_MSG((req as any).kind ?? "unknown", req);
    }

    let reqStr: string;
    try {
      reqStr = JSON.stringify(req);
    } catch {
      throw exceptions.UNEXPECTED_MSG(req.kind, req);
    }

    this.inner.send(
      reqStr,
      (resStr) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(resStr);
        } catch {
          throw exceptions.UNEXPECTED_MSG("unknown", resStr);
        }

        if (!isResponse(parsed)) {
          throw exceptions.UNEXPECTED_MSG((req as any).kind ?? "unknown", parsed);
        }

        if (parsed.kind !== req.kind) {
          throw exceptions.UNEXPECTED_MSG(req.kind, parsed);
        }

        if (parsed.head.corrId !== req.head.corrId) {
          throw exceptions.UNEXPECTED_MSG(req.kind, parsed);
        }

        callback(parsed as Extract<Response, { kind: K }>);
      },
      headers,
      retryForever,
    );
  }
}

export type { MessageSource };
