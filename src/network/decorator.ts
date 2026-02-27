import type { Network } from "./network.js";
import { isError, isResponse, type Request, type Response } from "./types.js";

export class DecoratedNetwork implements Network<Request, Response> {
  private inner: Network<string, string>;
  private verbose: boolean;

  constructor(inner: Network<string, string>, verbose: boolean = false) {
    this.inner = inner;
    this.verbose = verbose;
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
    const retries = retryForever ? Number.MAX_SAFE_INTEGER : 0;
    const delay = 10000;
    let attempt = 0;

    const doSend = () => {
      if (this.verbose) {
        console.log("[Network] Sending:", req);
      }

      this.inner.send(
        JSON.stringify(req),
        (resStr) => {
          let res: unknown;
          try {
            res = JSON.parse(resStr);
          } catch {
            attempt++;
            console.warn(`Server error (500) for ${req.kind}. Retrying in ${delay / 1000}s.`);
            setTimeout(doSend, delay);
            return;
          }

          if (!isResponse(res)) {
            attempt++;
            console.warn(`Server error (500) for ${req.kind}. Retrying in ${delay / 1000}s.`);
            setTimeout(doSend, delay);
            return;
          }

          if (res.kind !== req.kind) {
            attempt++;
            console.warn(`Server error (500) for ${req.kind}. Retrying in ${delay / 1000}s.`);
            setTimeout(doSend, delay);
            return;
          }

          if (res.head.corrId !== req.head.corrId) {
            attempt++;
            console.warn(`Server error (500) for ${req.kind}. Retrying in ${delay / 1000}s.`);
            setTimeout(doSend, delay);
            return;
          }

          if (isError(res) && attempt < retries) {
            attempt++;
            console.warn(`Server error (500) for ${req.kind}. Retrying in ${delay / 1000}s.`);
            setTimeout(doSend, delay);
            return;
          }

          if (this.verbose) {
            console.log(`[Network] Received ${res.head.status}:`, `for request:`, req, `response:${res.data}`);
          }

          callback(res as Extract<Response, { kind: K }>);
        },
        headers,
        retryForever,
      );
    };

    doSend();
  }
}
