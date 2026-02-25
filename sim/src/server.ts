import type { StepClock } from "../../src/clock.js";
import { type Change, Server } from "../../src/network/local.js";
import type { Message as NetworkMessage, Request, Response } from "../../src/network/types.js";
import * as util from "../../src/util.js";
import { type Address, anycast, Message, Process, type Random, unicast } from "./simulator.js";

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
  private prng: Random;
  server: Server = new Server();

  constructor(
    clock: StepClock,
    prng: Random,
    public readonly iaddr: string,
  ) {
    super(iaddr);
    this.clock = clock;
    this.prng = prng;
  }

  tick(tick: number, messages: Message<Request>[]): Message<{ err?: any; res?: Response } | NetworkMessage>[] {
    this.log(tick, "[recv]", messages);

    // Advance the clock so that server-side timeouts (e.g. PENDING_RETRY_TTL = 30000) can fire.
    this.clock.time += 100;

    const responses: Message<{ err?: any; res?: Response } | NetworkMessage>[] = [];
    const outgoing: Array<{ address: string; message: NetworkMessage }> = [];

    for (const message of messages) {
      util.assert(message.target.iaddr === this.iaddr);
      if (message.isRequest()) {
        let res: { err?: any; res?: Response };
        try {
          const result = this.server.apply(this.clock.time, message.data);
          outgoing.push(...extractOutgoing(result.changes));
          res = {
            res: {
              ...result.response,
              head: { ...result.response.head, corrId: message.data.head.corrId, version: message.data.head.version },
            } as Response,
          };
        } catch (err: any) {
          res = { err: err };
        }

        responses.push(message.resp(res));
      }
    }

    // Tick to process any remaining timeouts (50/50 chance)
    if (this.prng.next() < 0.5) {
      const tickResult = this.server.apply(this.clock.time, {
        kind: "debug.tick",
        head: { corrId: "", version: "" },
        data: { time: this.clock.time },
      });
      outgoing.push(...extractOutgoing(tickResult.changes));
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

    this.log(tick, "[send]", responses);
    return responses;
  }
}
