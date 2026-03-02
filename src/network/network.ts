export interface Network<Req, Res, Msg> {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  start(): void;
  stop(): void;

  send(req: Req, callback: (res: Res) => void): void;
  subscribe(type: "execute" | "notify", callback: (msg: Msg) => void): void;
  match(target: string): string;
}
