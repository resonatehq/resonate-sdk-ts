import type { Message, Request, Response } from "./types.js";

export interface Network {
  start(): void;
  stop(): void;

  send<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
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

  recv(msg: Message): void;
  subscribe(type: "execute" | "notify", callback: (msg: Message) => void): void;
  match(target: string): string;
}
