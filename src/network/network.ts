import type { Message } from "./types.js";

export interface Network<Req, Res> {
  start(): void;
  stop(): void;

  send(req: Req, callback: (res: Res) => void, headers?: { [key: string]: string }, retryForever?: boolean): void;
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
