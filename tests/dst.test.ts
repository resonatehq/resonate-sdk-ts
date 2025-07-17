import { FakeNetwork } from "../sim/fakeNetwork";
import type { Address } from "../sim/simulator";
import { Message, Process, Simulator, anycast, unicast } from "../sim/simulator";
import type {
  CreatePromiseReq,
  CreatePromiseRes,
  DurablePromiseRecord,
  RequestMsg,
  ResponseMsg,
} from "../src/network/network";
import { Server } from "../src/server";
import * as util from "../src/util";

class WorkerProcess extends Process {
  network: FakeNetwork;

  constructor(
    public readonly iaddr: string,
    public readonly gaddr: string[] = [],
  ) {
    super(iaddr, gaddr);
    this.network = new FakeNetwork();
  }

  tick(time: number, messages: Message<ResponseMsg>[]): Message<RequestMsg>[] {
    this.log(messages);
    return this.network.tick(time, messages);
  }
}

class ServerProcess extends Process {
  private server: Server;

  constructor(
    public readonly iaddr: string,
    public readonly gaddr: string[] = [],
  ) {
    super(iaddr, gaddr);
    this.server = new Server();
  }
  tick(
    time: number,
    messages: Message<RequestMsg>[],
  ): Message<
    | ResponseMsg
    | {
        recv: string;
        msg:
          | { kind: "invoke" | "resume"; id: string; counter: number }
          | { kind: "notify"; promise: DurablePromiseRecord };
      }
  >[] {
    const resps: Message<
      | ResponseMsg
      | {
          recv: string;
          msg:
            | { kind: "invoke" | "resume"; id: string; counter: number }
            | { kind: "notify"; promise: DurablePromiseRecord };
        }
    >[] = new Array();

    this.log(`tick ${time}`);

    for (const msg of messages) {
      switch (msg.data.kind) {
        case "createPromise":
          resps.push(msg.resp(this.createPromise(msg.data)));
          break;
        default:
          throw new Error(`Unsupported request kind: ${(msg.data as any).kind}`);
      }
      // append all responses and then return
    }
    // get msg to send.
    const step = this.server.step(time);
    let next = true;
    let result: IteratorResult<{
      recv: string;
      msg:
        | { kind: "invoke" | "resume"; id: string; counter: number }
        | { kind: "notify"; promise: DurablePromiseRecord };
    }>;

    do {
      result = step.next(next);
      if (!result.done) {
        const url = new URL(result.value.recv);
        util.assert(url.protocol === "local:");
        let target: Address;
        if (url.username === "any") {
          target =
            url.pathname === "" ? anycast(url.hostname) : anycast(url.hostname, `${url.hostname}${url.pathname}`);
        } else if (url.username === "uni") {
          target = unicast(`${url.hostname}${url.pathname}`);
        } else {
          throw new Error(`not handled ${url}`);
        }

        resps.push(new Message(unicast("server"), target, result.value));
        next = true; // true or false
      }
    } while (!result.done);

    return resps;
  }

  private createPromise(request: CreatePromiseReq): CreatePromiseRes {
    return {
      kind: "createPromise",
      promise: this.server.createPromise(
        request.id,
        request.timeout,
        request.param,
        request.tags,
        request.iKey,
        request.strict,
      ),
    };
  }
}

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
};

describe("DST", () => {
  it("dst test", () => {
    const seed = getArg("seed");
    const ticks = getArg("ticks");

    expect(seed).toBeDefined();
    expect(ticks).toBeDefined();
    console.log("seed:", seed);
    console.log("ticks:", ticks);

    const s = new Simulator(Number(seed!));

    // Server
    s.register(new ServerProcess("server"));

    // Workers
    s.register(new WorkerProcess("group/0", ["group"]));
    s.register(new WorkerProcess("group/1", ["group"]));

    s.addMessage(
      new Message(
        unicast("environment"),
        unicast("server"),
        {
          kind: "createPromise",
          id: "foo",
          timeout: Number.MAX_SAFE_INTEGER,
          tags: { "resonate:invoke": "local://any@group" },
          iKey: "foo",
        },
        { requ: true },
      ),
    );

    let i = 0;
    while (i <= Number(ticks!)) {
      s.tick();
      i++;
    }
  });
});
