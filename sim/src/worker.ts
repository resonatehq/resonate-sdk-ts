import type { Network, RecvMsg, RequestMsg, ResponseMsg } from "../../src/network/network";
import { ResonateInner } from "../../src/resonate-inner";
import type { CompResult } from "../../src/types";
import { type Address, Message, Process, Random, anycast, unicast } from "./simulator";

class SimulatedNetwork implements Network {
  private correlationId = 1;
  private buffer: Message<RequestMsg>[] = [];
  private callbacks: Record<number, { callback: (timeout: boolean, response: ResponseMsg) => void; timeout: number }> =
    {};
  private currentTime = 0;

  constructor(
    public readonly source: Address,
    public readonly target: Address,
  ) {}
  send(request: RequestMsg, callback: (timeout: boolean, response: ResponseMsg) => void): void {
    const message = new Message<RequestMsg>(this.source, this.target, request, {
      requ: true,
      correlationId: this.correlationId++,
    });
    this.callbacks[message.head!.correlationId] = { callback, timeout: this.currentTime + 5000 };
    this.buffer.push(message);
  }

  recv(msg: Message<RecvMsg>): void {
    this.onMessage?.(msg.data, () => {});
  }

  stop(): void {}

  onMessage?: (msg: RecvMsg, cb: (res: CompResult) => void) => void;

  time(time: number): void {
    this.currentTime = time;

    // Then, check for timed-out callbacks
    for (const key in this.callbacks) {
      const cb = this.callbacks[key];
      const hasTimedOut = cb.timeout < this.currentTime;
      if (hasTimedOut) {
        cb.callback(true, {
          kind: "error",
          code: "invalid_request",
          message: "timedout",
        });
        delete this.callbacks[key];
      }
    }
  }

  process(message: Message<ResponseMsg | RecvMsg>): void {
    if (message.isResponse()) {
      const correlationId = message.head?.correlationId;
      const entry = correlationId && this.callbacks[correlationId];
      if (entry) {
        entry.callback(false, message.data);
        delete this.callbacks[correlationId];
      }
    } else {
      this.recv(message as Message<RecvMsg>);
    }
  }
  flush(): Message<any>[] {
    // Finally, flush the buffer
    const flushed = this.buffer;
    this.buffer = [];
    return flushed;
  }
}

interface Options {
  charFlipProb?: number;
}
export class WorkerProcess extends Process {
  private network: SimulatedNetwork;
  private options: Required<Options>;
  private prng: Random;
  resonate: ResonateInner;

  constructor(
    public readonly iaddr: string,
    public readonly gaddr: string,
    seed: number,
    { charFlipProb = 0 }: Options = {},
  ) {
    super(iaddr, gaddr);
    this.network = new SimulatedNetwork(anycast(gaddr, iaddr), unicast("server"));
    this.options = { charFlipProb };
    this.prng = new Random(seed);
    this.resonate = new ResonateInner(this.network, { pid: iaddr, group: gaddr, ttl: 5000 });
  }

  tick(time: number, messages: Message<ResponseMsg | RecvMsg>[]): Message<RequestMsg>[] {
    if (this.options.charFlipProb > 0) {
      for (const msg of messages) {
        if (this.prng.next() < this.options.charFlipProb) {
          try {
            const json = JSON.stringify(msg.data);
            const corrupted = this.corruptOneChar(json);
            msg.data = JSON.parse(corrupted);
          } catch (err) {}
        }
      }
    }
    this.log(time, "[recv]", messages);

    this.network.time(time);
    for (const message of messages) {
      this.network.process(message);
    }

    const responses = this.network.flush();

    this.log(time, "[send]", responses);

    return responses;
  }

  private corruptOneChar(str: string): string {
    if (!str.length) return str;
    const idx = Math.floor(this.prng.next() * str.length);
    return `${str.slice(0, idx)}X${str.slice(idx + 1)}`;
  }
}
