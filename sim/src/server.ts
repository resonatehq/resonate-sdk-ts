import type { StepClock } from "../../src/clock.js";
import { type Change, Server } from "../../src/network/local.js";
import type { Message as NetworkMessage } from "../../src/network/types.js";
import * as util from "../../src/util.js";
import { type Address, anycast, Message, Process, unicast } from "./simulator.js";

function extractOutgoing(changes: Change[]): Array<{ address: string; message: NetworkMessage }> {
  const out: Array<{ address: string; message: NetworkMessage }> = [];
  for (const c of changes) {
    if (c.kind === "message.send") {
      out.push({ address: c.address, message: c.message });
    }
  }
  return out;
}

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

  tick(tick: number, messages: Message<string>[]): Message<{ err?: any; res?: string } | NetworkMessage>[] {
    this.log(tick, "[recv]", messages.length);

    // Advance the clock so that server-side timeouts (e.g. PENDING_RETRY_TTL = 30000) can fire.
    this.clock.time += 100;

    const responses: Message<{ err?: any; res?: string } | NetworkMessage>[] = [];
    const outgoing: Array<{ address: string; message: NetworkMessage }> = [];

    for (const message of messages) {
      util.assert(message.target.iaddr === this.iaddr);
      util.assert(typeof message.data === "string");
      if (message.isRequest()) {
        let res: { err?: any; res?: string };
        try {
          const data = JSON.parse(message.data);
          const result = this.server.apply(this.clock.time, data);
          outgoing.push(...extractOutgoing(result.changes));
          const response = result.response;
          res = {
            res: JSON.stringify({
              kind: response.kind,
              head: { corrId: data.head.corrId, status: response.head.status, version: data.head.version },
              data: response.data,
            }),
          };
        } catch (err: any) {
          res = { err };
        }

        responses.push(message.resp(res));
      }
    }

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

      responses.push(new Message<NetworkMessage>(unicast(this.iaddr), target, msg.message, { requ: true }));
    }

    this.log(tick, "[send]", responses.length);
    return responses;
  }
}
