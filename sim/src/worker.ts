import { assert, assertDefined, type Message as NetworkMessage, type Req, type Res } from "@resonatehq/dev";
import type { StepClock } from "../../src/clock";
import { Core } from "../../src/core";
import type { Encoder } from "../../src/encoder";
import { NoopEncryptor } from "../../src/encryptor";
import { Handler } from "../../src/handler";
import { NoopHeartbeat } from "../../src/heartbeat";
import type { MessageSource, Network } from "../../src/network/network";
import { OptionsBuilder } from "../../src/options";
import type { Registry } from "../../src/registry";
import { NoopTracer } from "../../src/tracer";
import type { Result } from "../../src/types";
import { type Address, Message, Process, type Random, unicast } from "./simulator";

interface DeliveryOptions {
  charFlipProb?: number;
}

class SimulatedMessageSource implements MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private subscriptions: {
    invoke: Array<(msg: NetworkMessage) => void>;
    resume: Array<(msg: NetworkMessage) => void>;
    notify: Array<(msg: NetworkMessage) => void>;
  } = { invoke: [], resume: [], notify: [] };

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

  subscribe(type: "invoke" | "resume" | "notify", callback: (msg: NetworkMessage) => void): void {
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
  private buffer: Message<Req>[] = [];
  private callbacks: Record<number, { req: Req; callback: (res: Res) => void; timeout: number }> = {};
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

  send(req: Req, cb: (res: Res) => void): void {
    const message = new Message<Req>(this.source, this.target, req, {
      requ: true,
      correlationId: this.correlationId++,
    });

    const callback = (res: Res) => {
      assert((res.kind === req.kind || res.kind === "error") && res.head.corrId === req.head.corrId);
      cb(res);
    };

    this.callbacks[message.head!.correlationId] = { req, callback, timeout: this.currentTime + 50000 };
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
          kind: "error",
          head: { corrId: cb.req.head.corrId, version: cb.req.head.version, status: 500 },
          data: "server timed out",
        });
        delete this.callbacks[key];
      }
    }
  }

  process(message: Message<{ err?: any; res?: Res } | NetworkMessage>): void {
    if (message.isResponse()) {
      assert(message.source === this.target);
      assert(message.target === this.source);
      const correlationId = message.head?.correlationId;
      const entry: { callback: (res: Result<Res, any>) => void; timeout: number } =
        correlationId && this.callbacks[correlationId];
      if (entry) {
        const msg = message as Message<{ err?: any; res?: Res }>;
        if (msg.data.err) {
          assert(msg.data.res === undefined);
          entry.callback({ kind: "error", error: msg.data.err });
        } else {
          assertDefined(msg.data.res);
          entry.callback({ kind: "value", value: this.maybeCorruptData(msg.data.res) });
        }
        delete this.callbacks[correlationId];
      }
    } else {
      assert(message.source.kind === this.target.kind && message.source.iaddr === this.target.iaddr);
      this.messageSource.recv((message as Message<NetworkMessage>).data);
    }
  }

  flush(): Message<any>[] {
    // Finally, flush the buffer
    const flushed = this.buffer;
    this.buffer = [];
    return flushed;
  }

  private maybeCorruptData(data: Res | NetworkMessage): any {
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
      unicast: messageSource.unicast,
      anycast: messageSource.anycast,
      pid: iaddr,
      ttl: 5000,
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

  tick(tick: number, messages: Message<{ err?: any; res?: Res } | NetworkMessage>[]): Message<Req>[] {
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
