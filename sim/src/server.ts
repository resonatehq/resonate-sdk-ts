import { Server } from "../../dev/server";
import type { Message as NetworkMessage, Request, Response } from "../../src/network/network";
import { type Address, Message, Process, anycast, unicast } from "./simulator";
import * as util from "../../src/util";

export class ServerProcess extends Process {
  server: Server = new Server();

  constructor(public readonly iaddr: string) {
    super(iaddr);
  }

  tick(time: number, messages: Message<Request>[]): Message<{ err?: any; res?: Response } | NetworkMessage>[] {
    this.log(time, "[recv]", messages);

    const responses: Message<{ err?: any; res?: Response } | NetworkMessage>[] = [];

    for (const message of messages) {
      util.assert(message.target.iaddr === this.iaddr);
      if (message.isRequest()) {
        let res: { err?: any; res?: Response };
        try {
          res = { res: this.server.process(message.data, time) };
        } catch (err: any) {
          res = { err: err };
        }

        responses.push(message.resp(res));
      }
    }

    for (const message of this.server.step(time)) {
      const url = new URL(message.recv);
      let target: Address;
      if (url.username === "any") {
        target = url.pathname === "" ? anycast(url.hostname) : anycast(url.hostname, url.pathname.slice(1));
      } else if (url.username === "uni") {
        target = unicast(url.pathname.slice(1));
      } else {
        throw new Error(`not handled ${url}`);
      }

      const msg = new Message<NetworkMessage>(unicast(this.iaddr), target, message.msg, { requ: true });
      responses.push(msg);
    }

    this.log(time, "[send]", responses);
    return responses;
  }
}
