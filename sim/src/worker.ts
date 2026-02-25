import type { StepClock } from "../../src/clock.js";
import { Core } from "../../src/core.js";
import type { Encoder } from "../../src/encoder.js";
import { NoopEncryptor } from "../../src/encryptor.js";
import { Handler } from "../../src/handler.js";
import { NoopHeartbeat } from "../../src/heartbeat.js";
import type { MessageSource, Network } from "../../src/network/network.js";
import type { Message as NetworkMessage, Request, Response } from "../../src/network/types.js";
import { OptionsBuilder } from "../../src/options.js";
import type { Registry } from "../../src/registry.js";
import { NoopTracer } from "../../src/tracer.js";
import * as util from "../../src/util.js";
import { type Address, Message, Process, type Random, unicast } from "./simulator.js";

interface DeliveryOptions {
  charFlipProb?: number;
}

class SimulatedMessageSource implements MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private subscriptions: {
    execute: Array<(msg: NetworkMessage) => void>;
    notify: Array<(msg: NetworkMessage) => void>;
  } = { execute: [], notify: [] };

  constructor(
    iaddr: string,
    gaddr: string,
    private maybeCorruptData: (data: NetworkMessage) => any,
  ) {
    this.pid = iaddr;
    this.group = gaddr;
    this.unicast = `sim://uni@${gaddr}/${iaddr}`;
    this.anycast = `sim://any@${gaddr}/${iaddr}`;
  }

  start(): void {}

  recv(msg: NetworkMessage): void {
    for (const callback of this.subscriptions[msg.kind]) {
      callback(this.maybeCorruptData(msg));
    }
  }

  subscribe(type: "execute" | "notify", callback: (msg: NetworkMessage) => void): void {
    this.subscriptions[type].push(callback);
  }

  stop(): void {}

  match(target: string): string {
    return `sim://any@${target}`;
  }
}

class SimulatedNetwork implements Network {
  private correlationId = 1;
  private currentTime = 0;

  private prng: Random;
  private deliveryOptions: Required<DeliveryOptions>;
  private buffer: Message<Request>[] = [];
  private callbacks: Record<
    number,
    {
      req: Request;
      callback: (res: any) => void;
      timeout: number;
      headers?: { [key: string]: string };
    }
  > = {};
  private messageSource: SimulatedMessageSource;

  constructor(
    iaddr: string,
    gaddr: string,
    prng: Random,
    { charFlipProb = 0 }: DeliveryOptions,
    public readonly source: Address,
    public readonly target: Address,
  ) {
    this.prng = prng;
    this.deliveryOptions = { charFlipProb };
    this.messageSource = new SimulatedMessageSource(iaddr, gaddr, (data) => this.maybeCorruptData(data));
  }

  start(): void {}
  getMessageSource(): MessageSource {
    return this.messageSource;
  }

  send<K extends Request["kind"]>(
    req: Extract<Request, { kind: K }>,
    callback: (res: Extract<Response, { kind: K }>) => void,
    headers?: { [key: string]: string },
  ): void {
    const message = new Message<Request>(this.source, this.target, req, {
      requ: true,
      correlationId: this.correlationId++,
    });

    const cb = (res: Extract<Response, { kind: K }>) => {
      if (res.head.status >= 400) {
        callback(res);
      } else {
        util.assert(res.kind === req.kind, "res kind must match req kind");
        callback(res);
      }
    };

    this.callbacks[message.head!.correlationId] = {
      req,
      callback: cb,
      timeout: this.currentTime + 2000,
      headers,
    };
    this.buffer.push(message);
  }

  stop(): void {}

  time(time: number): void {
    this.currentTime = time;

    // Then, check for timed-out callbacks
    for (const key in this.callbacks) {
      const cb = this.callbacks[key];
      const hasTimedOut = cb.timeout < this.currentTime;
      if (hasTimedOut) {
        cb.callback({
          kind: cb.req.kind,
          head: { corrId: cb.req.head.corrId, version: cb.req.head.version, status: 500 },
          data: "req timed out",
        } as any);
        delete this.callbacks[key];
      }
    }
  }

  process(message: Message<{ err?: any; res?: Response } | NetworkMessage>): void {
    if (message.isResponse()) {
      util.assert(message.source === this.target);
      util.assert(message.target === this.source);
      const correlationId = message.head?.correlationId;
      const entry = correlationId && this.callbacks[correlationId];
      if (entry) {
        const msg = message as Message<{ err?: any; res?: Response }>;
        if (msg.data.err) {
          util.assert(msg.data.res === undefined);
          entry.callback({
            kind: entry.req.kind,
            head: { corrId: entry.req.head.corrId, version: entry.req.head.version, status: 500 },
            data: typeof msg.data.err === "string" ? msg.data.err : msg.data.err?.message || "unknown error",
          } as Response);
        } else {
          util.assertDefined(msg.data.res);
          entry.callback(this.maybeCorruptData(msg.data.res));
        }
        delete this.callbacks[correlationId];
      }
    } else {
      util.assert(message.source.kind === this.target.kind && message.source.iaddr === this.target.iaddr);
      this.messageSource.recv((message as Message<NetworkMessage>).data);
    }
  }

  flush(): Message<any>[] {
    // Finally, flush the buffer
    const flushed = this.buffer;
    this.buffer = [];
    return flushed;
  }

  private maybeCorruptData(data: Response | NetworkMessage): any {
    // Serialize the data to a string
    let jsonStr = JSON.stringify(data);

    // Randomly decide whether to corrupt
    const shouldCorrupt = this.prng.next() < this.deliveryOptions.charFlipProb;
    if (!shouldCorrupt) return data;

    // Pick a random index to corrupt
    const idx = Math.floor(this.prng.next() * jsonStr.length);

    // Corrupt that character
    jsonStr = `${jsonStr.slice(0, idx)}X${jsonStr.slice(idx + 1)}`;

    // Return corrupted string, even if it's invalid JSON
    return jsonStr;
  }
}

export class WorkerProcess extends Process {
  private clock: StepClock;
  private network: SimulatedNetwork;
  private registry: Registry;
  private core: Core;

  constructor(
    prng: Random,
    clock: StepClock,
    encoder: Encoder,
    registry: Registry,
    { charFlipProb = 0 }: DeliveryOptions,
    public readonly iaddr: string,
    public readonly gaddr: string,
  ) {
    super(iaddr, gaddr);
    this.clock = clock;
    this.network = new SimulatedNetwork(iaddr, gaddr, prng, { charFlipProb: 0 }, unicast(iaddr), unicast("server"));
    this.registry = registry;
    const messageSource = this.network.getMessageSource();
    this.core = new Core({
      pid: iaddr,
      ttl: 10000,
      clock: this.clock,
      network: this.network,
      handler: new Handler(this.network, encoder, new NoopEncryptor()),
      messageSource: this.network.getMessageSource(),
      registry: registry,
      heartbeat: new NoopHeartbeat(),
      dependencies: new Map(),
      optsBuilder: new OptionsBuilder({ match: messageSource.match, idPrefix: "" }),
      verbose: false,
      tracer: new NoopTracer(),
    });
  }

  tick(tick: number, messages: Message<{ err?: any; res?: Response } | NetworkMessage>[]): Message<Request>[] {
    this.log(tick, "[recv]", messages);

    this.network.time(this.clock.time);
    for (const message of messages) {
      this.network.process(message);
    }

    const responses = this.network.flush();

    this.log(tick, "[send]", responses);

    return responses;
  }
}
