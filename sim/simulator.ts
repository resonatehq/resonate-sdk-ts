

class Random {
  // Internal state of the random number generator (RNG)
  private state: number;

  constructor(seed: number) {
    // Ensure the seed is treated as an unsigned 32-bit integer
    this.state = seed >>> 0;
  }

  next(): number {
    // Update the internal state using the LCG formula
    this.state = (1664525 * this.state + 1013904223) >>> 0;

    // Convert the 32-bit integer to a float in the range [0, 1)
    return this.state / 0x100000000; // Equivalent to 2^32
  }
}

export type Address = { kind: "unicast"; iaddr: string } | { kind: "anycast"; gaddr: string; iaddr?: string };
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
    return this.head.requ;
  }

  isResponse(): boolean {
    return this.head.resp;
  }
  resp<U>(target: Address, data: U) {
    return new Message(target, data, { resp: this.head.requ });
  }
}

class Process {
  public active = true;

  constructor(
    public readonly iaddr: string,
    public readonly gaddr: string[] = [],
  ) {}

  tick(time: number, messages: Message<any>[]): Message<any>[] {
    throw new Error("not implemented");
  }

  log(...args: any[]): void {
    console.log(`proc [${this.iaddr}]`, ...args);
  }
}



export class DeliveryOptions {
  dropProb: number;
  randomDelay: number;
  duplProb: number;

  constructor(dropProb = 0, randomDelay = 0, duplProb = 0) {
    this.dropProb = dropProb;
    this.randomDelay = randomDelay;
    this.duplProb = duplProb;
  }
}

export class Simulator {
  private prng: Random;
  private time = 0;
  private init = false;
  private process: Process[] = [];
  private network: Message<any>[] = [];
  public deliveryOptions: DeliveryOptions;

  constructor(seed: number, deliveryOptions: DeliveryOptions = new DeliveryOptions()) {
    this.prng = new Random(seed);
    this.deliveryOptions = deliveryOptions;
  }

  addMessage(message: Message<any>): void {
    this.network.push(message);
  }

  assertAlways(cond: boolean, msg: string): void {
    if (cond) return; // Early return if assertion passes

    console.assert(cond, "Assertion Failed: %s", msg);
    console.trace();

    if (typeof process !== "undefined" && process.versions.node) {
      process.exit(1);
    }
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
    console.log("sim tick", this.network);
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
      }
    }

    const inboxes: Record<string, Message<any>[]> = {};
    for (const process of this.process) {
      inboxes[process.iaddr] = [];
    }
    for (const message of consumed) {
      const target = message.target;
      if (target.kind === "unicast") {
        if (target.iaddr === "environment") {
          console.log(message);
        }

        if (target.iaddr in inboxes) {
          inboxes[target.iaddr].push(message);
        }
      } else if (target.kind === "anycast") {
        const preference = this.process.find((p) => p.active && p.iaddr === target.iaddr);
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
      } else {
        throw new Error("unknown target.kind");
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
