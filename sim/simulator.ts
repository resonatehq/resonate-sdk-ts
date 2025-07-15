import { RequestMsg, ResponseMsg } from "../src/network/network";
import { Server } from "../src/server";

class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
}

export type Address =
  | { kind: "unicast"; iaddr: string }
  | { kind: "anycast"; gaddr: string; iaddr?: string };

export function unicast(iaddr: string): Address {
  return { kind: "unicast", iaddr };
}

export function anycast(gaddr: string, iaddr?: string): Address {
  return { kind: "anycast", gaddr, iaddr };
}

export class Message<T> {
  constructor(
    public target: Address,
    public data: T,
    public head: Record<string, any> = {},
  ) {}
  isRequest(): boolean {
    return this.head.hasOwnProperty("requ");
  }
  resp<U>(target: Address, data: U) {
    return new Message(target, data, { resp: this.head.requ });
  }
}


export class Process {
  public active: boolean = true;

  constructor(
    public readonly iaddr: string,
    public readonly gaddr: string[] = [],
  ) {
  }

  tick(time: number, messages: Message<any>[]): Message<any>[] {
    return []
  }

  log(...args: any[]): void {
    console.log(`proc [${this.iaddr}]`, ...args);
  }
}


export class DeliveryOptions {
  dropProb: number;
  randomDelay: number;
  duplProb: number;

  constructor(
    dropProb: number = 0,
    randomDelay: number = 0,
    duplProb: number = 0,
  ) {
    this.dropProb = dropProb;
    this.randomDelay = randomDelay;
    this.duplProb = duplProb;
  }
}

export class Simulator {
  private prng: Random;
  private time: number = 0;
  private init: boolean = false;
  private process: Process[] = [];
  private network: Message<any>[] = [];
  public deliveryOptions: DeliveryOptions;

  assertAlways(condition: boolean, message: string): void {
    if (!condition) {
      console.error("Assertion failed:", message);
      process.exit(1);
    }
  }

  constructor(
    seed: number,
    deliveryOptions: DeliveryOptions = new DeliveryOptions(),
  ) {
    this.prng = new Random(seed);
    this.deliveryOptions = deliveryOptions;
  }

  register(process: Process): void {
    this.process.push(process);
  }

  more(): boolean {
    // Simulator can make progress if it is not initialized or if there are messages in the network
    return !this.init || this.network.length > 0;
  }

  send(message: Message<any>): void {
    this.network.push(message);
  }

  tick(): void {
    // console.log("sim tick", this.network);

    if (!this.init) {
      this.init = true;
    }

    this.time += 1;

    const retained: Message<any>[] = [];
    const consumed: Message<any>[] = [];

    for (const message of this.network) {
      // Drop?
      if (this.prng.next() < this.deliveryOptions.dropProb) {
        continue;
      }

      // Delay?
      if (this.prng.next() < this.deliveryOptions.randomDelay) {
        retained.push(message);
        continue;
      }

      // Deliver now
      consumed.push(message);

      // Duplicate?
      if (this.prng.next() < this.deliveryOptions.duplProb) {
        retained.push(message);
        continue;
      }
    }

    const inboxes: Record<string, Message<any>[]> = {};

    for (const process of this.process) {
      inboxes[process.iaddr] = [];
    }

    for (const message of consumed) {
      const target = message.target;
      if (target.kind === "unicast") {
        inboxes[target.iaddr].push(message);
      } else {
        const preference = this.process.find(
          (p) => p.active && p.iaddr === target.iaddr,
        );
        if (preference) {
          inboxes[preference.iaddr].push(message);
        } else {
          for (const process of this.process) {
            if (process.active && process.gaddr.includes(target.gaddr)) {
              inboxes[process.iaddr].push(message);
              break;
            }
          }
        }
      }
    }

    const newMessages: Message<any>[] = [];

    for (const process of this.process) {
      if (!process.active) {
        continue;
      }
      newMessages.push(...process.tick(this.time, inboxes[process.iaddr]));
    }

    this.network = retained.concat(newMessages);
  }
}
