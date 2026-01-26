import { assert, Message, Req, Res, Server } from "@resonatehq/dev";
import type { ResonateError } from "../src/exceptions";
import type { MessageSource, Network } from "../src/network/network";
import type { Result } from "../src/types";
import * as util from "../src/util";

export class LocalNetwork implements Network {
  private server: Server;
  private messageSource: LocalMessageSource;

  constructor({
    pid = "pid",
    group = "default",
    server = new Server(),
  }: { pid?: string; group?: string; server?: Server } = {}) {
    this.server = server;
    this.messageSource = new LocalMessageSource(pid, group, server);
  }

  getMessageSource(): MessageSource {
    return this.messageSource;
  }

  start() {}
  stop() {}

  send(req: Req, callback: (res: Res) => void): void {
    setTimeout(() => {
        const res = this.server.process({at: Date.now(), req});
        assert((res.kind === req.kind || res.kind === "error") && res.head.corrId === req.head.corrId, "res kind must match req kind");
        callback(res);
        this.messageSource.enqueueNext();

    });
  }
}

export class LocalMessageSource implements MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;
  private server: Server;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private shouldStop = false;
  private subscriptions: {
    invoke: Array<(msg: Message) => void>;
    resume: Array<(msg: Message) => void>;
    notify: Array<(msg: Message) => void>;
  } = { invoke: [], resume: [], notify: [] };

  constructor(pid: string, group: string, server: Server) {
    this.pid = pid;
    this.group = group;
    this.unicast = `poll://uni@${group}/${pid}`;
    this.anycast = `poll://any@${group}/${pid}`;
    this.server = server;
    this.timeoutId = undefined;
  }

  start() {}

  stop() {
    clearTimeout(this.timeoutId);
    this.shouldStop = true;
    this.timeoutId = undefined;
  }

  recv(mesg: Message): void {
    for (const callback of this.subscriptions[mesg.kind]) {
      callback(mesg);
    }
  }

  subscribe(type: "invoke" | "resume" | "notify", callback: (msg: Message) => void): void {
    this.subscriptions[type].push(callback);
  }

  enqueueNext(): void {
    clearTimeout(this.timeoutId);

    const time = Date.now();
    const next = this.server.next({at:time});

    if (next !== undefined && !this.shouldStop) {
      this.timeoutId = setTimeout((): void => {
        for (const { mesg } of this.server.step({at: time})) {
          this.recv(mesg);
        }
        this.enqueueNext();
      }, next);
    }
  }

  match(target: string): string {
    return `poll://any@${target}`;
  }
}
