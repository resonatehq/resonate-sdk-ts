import type { StepClock } from "../../src/clock.js";
import { Server } from "../../src/network/local.js";
import type { Msg as NetworkMessage, Req, Res } from "../../src/network/types.js";
import * as util from "../../src/util.js";
import { type Address, anycast, Message, Process, unicast } from "./simulator.js";

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
    const outgoing: Array<{ id: string; version: number; address: string }> = [];

    for (const message of messages) {
      util.assert(message.target.iaddr === this.iaddr);
      if (message.isRequest()) {
        let res: { err?: any; res?: Res };
        try {
          const result = this.server.apply(this.clock.time, message.data);
          outgoing.push(...result.messages);
          res = {
            res: {
              ...result.response,
              head: { ...result.response.head, corrId: message.data.head.corrId, version: message.data.head.version },
            } as Res,
          };
        } catch (err: any) {
          res = { err: err };
        }

        responses.push(message.resp(res));
      }
    }

    // Tick to process any remaining timeouts
    const tickResult = this.server.apply(this.clock.time);
    outgoing.push(...tickResult.messages);

    for (const msg of outgoing) {
      const url = new URL(msg.address);
      let target: Address;
      if (url.username === "any") {
        target = url.pathname === "" ? anycast(url.hostname) : anycast(url.hostname, url.pathname.slice(1));
      } else if (url.username === "uni") {
        target = unicast(url.pathname.slice(1));
      } else {
        throw new Error(`not handled ${url}`);
      }

      const networkMsg: NetworkMessage = {
        kind: "execute",
        head: {},
        data: { task: { id: msg.id, version: msg.version } },
      };
      responses.push(new Message<NetworkMessage>(unicast(this.iaddr), target, networkMsg, { requ: true }));
    }

    this.log(tick, "[send]", responses);
    return responses;
  }
}
