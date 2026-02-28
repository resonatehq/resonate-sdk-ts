import type { StepClock } from "../../src/clock.js";
import { Codec } from "../../src/codec.js";
import { Core } from "../../src/core.js";
import { NoopHeartbeat } from "../../src/heartbeat.js";
import { validateResponse } from "../../src/network/decorator.js";
import type { Network } from "../../src/network/network.js";
import {
  isMessage,
  isRequest,
  isResponse,
  type Message as NetworkMessage,
  type Request,
  type Response,
} from "../../src/network/types.js";

import { OptionsBuilder } from "../../src/options.js";
import type { Registry } from "../../src/registry.js";
import * as util from "../../src/util.js";
import { type Address, Message, Process, type Random, unicast } from "./simulator.js";

interface DeliveryOptions {
  charFlipProb?: number;
}

class SimulatedNetwork implements Network<string, string, string> {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private subscribers: Array<(msg: string) => void> = [];
  private correlationId = 1;
  private currentTime = 0;

  private prng: Random;
  private deliveryOptions: Required<DeliveryOptions>;
  private buffer: Message<string>[] = [];
  private callbacks: Record<
    number,
    {
      req: string;
      callback: (res: string) => void;
      timeout: number;
      headers?: { [key: string]: string };
    }
  > = {};

  constructor(
    iaddr: string,
    gaddr: string,
    prng: Random,
    { charFlipProb = 0 }: DeliveryOptions,
    public readonly source: Address,
    public readonly target: Address,
  ) {
    this.pid = iaddr;
    this.group = gaddr;
    this.unicast = `sim://uni@${gaddr}/${iaddr}`;
    this.anycast = `sim://any@${gaddr}/${iaddr}`;
    this.prng = prng;
    this.deliveryOptions = { charFlipProb };
  }

  start(): void {}
  stop(): void {}

  subscribe(_type: "execute" | "notify", callback: (msg: string) => void): void {
    this.subscribers.push(callback);
  }

  match(target: string): string {
    return `sim://any@${target}`;
  }

  recv(msg: string): void {
    for (const callback of this.subscribers) {
      callback(this.maybeCorruptData(msg));
    }
  }

  send(req: string, callback: (res: string) => void, headers?: { [key: string]: string }): void {
    const message = new Message<string>(this.source, this.target, req, {
      requ: true,
      correlationId: this.correlationId++,
    });

    this.callbacks[message.head!.correlationId] = {
      req,
      callback,
      timeout: this.currentTime + 2000,
      headers,
    };
    this.buffer.push(message);
  }

  time(time: number): void {
    this.currentTime = time;

    // Then, check for timed-out callbacks
    for (const key in this.callbacks) {
      const cb = this.callbacks[key];
      const hasTimedOut = cb.timeout < this.currentTime;
      if (hasTimedOut) {
        const req = JSON.parse(cb.req);
        util.assert(isRequest(req));
        const res = {
          kind: req.kind,
          head: { corrId: req.head.corrId, version: req.head.version, status: 500 },
          data: "req timed out",
        };
        util.assert(isResponse(res));
        cb.callback(JSON.stringify(res));
        delete this.callbacks[key];
      }
    }
  }

  process(message: Message<string>): void {
    if (message.isResponse()) {
      util.assert(message.source === this.target);
      util.assert(message.target === this.source);
      const correlationId = message.head?.correlationId;
      const entry = correlationId && this.callbacks[correlationId];
      if (entry) {
        util.assertDefined(message.data);
        entry.callback(this.maybeCorruptData(message.data));
        delete this.callbacks[correlationId];
      }
    } else {
      util.assert(message.source.kind === this.target.kind && message.source.iaddr === this.target.iaddr);
      this.recv(message.data);
    }
  }

  flush(): Message<any>[] {
    // Finally, flush the buffer
    const flushed = this.buffer;
    this.buffer = [];
    return flushed;
  }

  private maybeCorruptData(data: string): string {
    // Randomly decide whether to corrupt
    const shouldCorrupt = this.prng.next() < this.deliveryOptions.charFlipProb;
    if (!shouldCorrupt) return data;

    // Pick a random index to corrupt
    const idx = Math.floor(this.prng.next() * data.length);

    // Corrupt that character
    return `${data.slice(0, idx)}X${data.slice(idx + 1)}`;
  }
}

class SimulatedDecoratedNetwork implements Network<Request, Response, NetworkMessage> {
  private inner: SimulatedNetwork;
  private retries: number;

  constructor(inner: SimulatedNetwork, retryForever: boolean = false) {
    this.inner = inner;
    this.retries = retryForever ? Number.MAX_SAFE_INTEGER : 0;
  }

  get pid(): string {
    return this.inner.pid;
  }

  get group(): string {
    return this.inner.group;
  }

  get unicast(): string {
    return this.inner.unicast;
  }

  get anycast(): string {
    return this.inner.anycast;
  }

  start(): void {
    this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  subscribe(type: "execute" | "notify", callback: (msg: NetworkMessage) => void): void {
    this.inner.subscribe(type, (msgStr: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msgStr);
      } catch {
        return;
      }
      if (!isMessage(parsed)) {
        return;
      }
      if (parsed.kind !== type) {
        return;
      }
      callback(parsed);
    });
  }

  match(target: string): string {
    return this.inner.match(target);
  }

  send<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
  ): void {
    let attempt = 0;

    const doSend = () => {
      this.inner.send(JSON.stringify(req), (resStr) => {
        const result = validateResponse(resStr, req.kind, req.head.corrId);

        if (!result.valid) {
          attempt++;
          doSend();
          return;
        }

        if (result.error && attempt < this.retries) {
          attempt++;
          doSend();
          return;
        }

        callback(result.res as Extract<Response, { kind: K }>);
      });
    };

    doSend();
  }
}

export class WorkerProcess extends Process {
  private clock: StepClock;
  private network: SimulatedNetwork;
  private decoratedNetwork: SimulatedDecoratedNetwork;

  constructor(
    prng: Random,
    clock: StepClock,
    registry: Registry,
    { charFlipProb }: DeliveryOptions,
    public readonly iaddr: string,
    public readonly gaddr: string,
  ) {
    super(iaddr, gaddr);
    this.clock = clock;
    this.network = new SimulatedNetwork(iaddr, gaddr, prng, { charFlipProb }, unicast(iaddr), unicast("server"));
    this.decoratedNetwork = new SimulatedDecoratedNetwork(this.network);
    new Core({
      pid: iaddr,
      ttl: 10000,
      clock: this.clock,
      network: this.decoratedNetwork,
      codec: new Codec(),
      registry,
      heartbeat: new NoopHeartbeat(),
      dependencies: new Map(),
      optsBuilder: new OptionsBuilder({ match: this.decoratedNetwork.match.bind(this.decoratedNetwork), idPrefix: "" }),
      verbose: false,
    });
  }

  tick(tick: number, messages: Message<string>[]): Message<string>[] {
    this.log(tick, "[recv]", messages.length);

    this.network.time(this.clock.time);
    for (const message of messages) {
      this.network.process(message);
    }

    const responses = this.network.flush();

    this.log(tick, "[send]", responses.length);

    return responses;
  }
}
