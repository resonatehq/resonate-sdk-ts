import type { Msg, Req, Res } from "./types";

export interface Network {
  start(): void;
  stop(): void;

  send<K extends Req["kind"]>(
    req: Extract<Req, { kind: K }>,
    callback: (res: Extract<Res, { kind: K }>) => void,
    headers?: { [key: string]: string },
    retryForever?: boolean,
  ): void;
  getMessageSource?: () => MessageSource;
}

export interface MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  start(): void;
  stop(): void;

  recv(msg: Msg): void;
  subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Msg) => void): void;
  match(target: string): string;
}
