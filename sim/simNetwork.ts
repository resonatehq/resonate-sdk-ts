import type { Network, RecvMsg, RequestMsg, ResponseMsg } from "../src/network/network";
import { type Message, anycast, unicast } from "./simulator";

export class SimNetwork implements Network {
  correlationId = 0;
  buffer: Message<any>[] = [];
  callbacks: Record<number, { callback: (timeout: boolean, response: ResponseMsg) => void; timeout: number }> = {};
  currentTime = 0;

  send(request: RequestMsg, callback: (timeout: boolean, response: ResponseMsg) => void): void {
    throw new Error("not implemented");
  }

  recv(msg: RecvMsg): void {
    throw new Error("not implemented");
  }

  tick(time: number, messages: Message<any>[]): Message<any>[] {
    this.currentTime = time;

    for (const m of messages) {
      if (m.isResponse()) {
        if (this.callbacks[m.head!.correlationId]) {
          this.callbacks[m.head!.correlationId].callback(false, m.data);
          delete this.callbacks[m.head!.correlationId];
        }
      } else {
        this.recv(m);
      }
    }

    for (const k in this.callbacks) {
      const cb = this.callbacks[k];
      if (cb.timeout < this.currentTime) {
        cb.callback(true, { kind: "error", code: "invalid_request", message: "timedout" });
        delete this.callbacks[k];
      }
    }

    const temp = this.buffer;
    this.buffer = [];
    return temp;
  }
}
