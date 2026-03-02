export interface Network {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  start(): void;
  stop(): void;

  send(req: string, callback: (res: string) => void): void;
  recv(callback: (msg: string) => void): void;
  match(target: string): string;
}
