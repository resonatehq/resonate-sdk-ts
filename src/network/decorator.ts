import type { Network } from "./network.js";
import { isError, isMessage, isResponse, type Message, type Request, type Response } from "./types.js";

export type ValidationResult = { valid: true; res: Response; error: boolean } | { valid: false };

export function validateResponse(resStr: string, kind: string, corrId: string): ValidationResult {
  let res: unknown;
  try {
    res = JSON.parse(resStr);
  } catch {
    return { valid: false };
  }

  if (!isResponse(res)) return { valid: false };
  if (res.kind !== kind) return { valid: false };
  if (res.head.corrId !== corrId) return { valid: false };

  return { valid: true, res, error: isError(res) };
}

export class DecoratedNetwork implements Network<Request, Response, Message> {
  private inner: Network<string, string, string>;
  private verbose: boolean;

  constructor(inner: Network<string, string, string>, verbose: boolean = false) {
    this.inner = inner;
    this.verbose = verbose;
  }

  get pid(): string {
    return this.inner.pid;
  }
  get group(): string {
    return this.inner.group;
  }
  get unicast(): string {
    return this.inner.unicast;
  }
  get anycast(): string {
    return this.inner.anycast;
  }

  start(): void {
    this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  subscribe(type: "execute" | "notify", callback: (msg: Message) => void): void {
    this.inner.subscribe(type, (msgStr: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msgStr);
      } catch {
        console.warn("[Network] Received invalid JSON message, discarding");
        return;
      }
      if (!isMessage(parsed)) {
        console.warn("[Network] Received invalid message, discarding");
        return;
      }
      if (parsed.kind !== type) {
        return;
      }
      callback(parsed);
    });
  }

  match(target: string): string {
    return this.inner.match(target);
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
          const result = validateResponse(resStr, req.kind, req.head.corrId);

          if (!result.valid) {
            attempt++;
            console.warn(`Server error (500) for ${req.kind}. Retrying in ${delay / 1000}s.`);
            setTimeout(doSend, delay);
            return;
          }

          if (result.error && attempt < retries) {
            attempt++;
            console.warn(`Server error (500) for ${req.kind}. Retrying in ${delay / 1000}s.`);
            setTimeout(doSend, delay);
            return;
          }

          if (this.verbose) {
            console.log(
              `[Network] Received ${result.res.head.status}:`,
              `for request:`,
              req,
              `response:${result.res.data}`,
            );
          }

          callback(result.res as Extract<Response, { kind: K }>);
        },
        headers,
        retryForever,
      );
    };

    doSend();
  }
}
