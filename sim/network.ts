import { Message, unicast } from "./simulator";
import type {
  Network,
  RecvMsg,
  RequestMsg,
  ResponseMsg,
} from "../src/network/network";

export class SimulatedNetwork implements Network {
  private correlationId = 0;
  private buffer: Message<RequestMsg>[] = [];
  private callbacks: Record<number, { callback: (timeout: boolean, response: ResponseMsg) => void; timeout: number }> =
    {};
  private currentTime = 0;

  send(request: RequestMsg, callback: (timeout: boolean, response: ResponseMsg) => void): void {
    const message = new Message<RequestMsg>(unicast("server"), request, {
      requ: true,
      correlationId: this.correlationId++,
    });
    this.callbacks[message.head!.correlationId] = { callback, timeout: this.currentTime + 5000 };
    this.buffer.push(message);
  }

  recv(msg: any): void {}
  onMessage?: (msg: RecvMsg) => void;

  tick(messages: Message<RequestMsg>[], time: number): Message<RequestMsg>[] {
    this.currentTime = time;

    // First, handle incoming messages
    for (const message of messages) {
      if (message.isResponse()) {
        const correlationId = message.head?.correlationId;
        const entry = correlationId && this.callbacks[correlationId];

        if (entry) {
          entry.callback(false, message.data);
          delete this.callbacks[correlationId];
        }
      } else {
        this.recv(message);
      }
    }

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

    // Finally, flush the buffer
    const flushed = this.buffer;
    this.buffer = [];
    return flushed;
  }
}
