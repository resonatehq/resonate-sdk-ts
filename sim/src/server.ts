import { assert, type Message as NetworkMessage, type Req, type Res, Server } from "@resonatehq/dev";
import type { StepClock } from "../../src/clock";
import { type Address, anycast, Message, Process, unicast } from "./simulator";

export class ServerProcess extends Process {
  private clock: StepClock;
  server: Server = new Server();

  constructor(
    clock: StepClock,
    public readonly iaddr: string,
  ) {
    super(iaddr);
    this.clock = clock;
  }

  tick(tick: number, messages: Message<Req>[]): Message<{ err?: any; res?: Res } | NetworkMessage>[] {
    this.log(tick, "[recv]", messages);

    const responses: Message<{ err?: any; res?: Res } | NetworkMessage>[] = [];

    for (const message of messages) {
      assert(message.target.iaddr === this.iaddr);
      if (message.isRequest()) {
        let res: { err?: any; res?: Res };
        try {
          res = { res: this.server.process({ at: this.clock.time, req: message.data }) };
        } catch (err: any) {
          res = { err: err };
        }

        responses.push(message.resp(res));
      }
    }

    for (const message of this.server.step({ at: this.clock.time })) {
      const url = new URL(message.recv);
      let target: Address;
      if (url.username === "any") {
        target = url.pathname === "" ? anycast(url.hostname) : anycast(url.hostname, url.pathname.slice(1));
      } else if (url.username === "uni") {
        target = unicast(url.pathname.slice(1));
      } else {
        throw new Error(`not handled ${url}`);
      }

      const msg = new Message<NetworkMessage>(unicast(this.iaddr), target, message.mesg, { requ: true });
      responses.push(msg);
    }

    this.log(tick, "[send]", responses);
    return responses;
  }
}
