// Records

import type { Message, Req, Res } from "@resonatehq/dev";

export interface Network {
  start(): void;
  stop(): void;

  send(req: Req, callback: (res: Res) => void, retryForever?: boolean): void;
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
  subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Message) => void): void;
  match(target: string): string;
}
