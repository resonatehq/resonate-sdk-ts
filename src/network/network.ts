export interface Network {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  send(req: string): Promise<string>;
  recv(callback: (msg: string) => void): void;
  match(target: string): string;
}
