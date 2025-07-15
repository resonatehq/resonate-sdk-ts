import { Simulator, Process, Message, unicast, anycast, Address } from "./simulator";
import { CreatePromiseReq, CreatePromiseRes, DurablePromiseRecord, RequestMsg, ResponseMsg } from "../src/network/network";
import { Server } from "../src/server";
import * as util from "../src/util";

class Ping extends Process {
  tick(time: number, messages: Message<any>[]): Message<any>[] {
    for (const msg of messages){
      this.log(msg)
    }
    return [new Message(anycast("g2"), `ping at ${time}`, {requ: true})]
  }
}

class Worker extends Process{
  tick(time: number, messages: Message<ResponseMsg>[]): Message<RequestMsg>[] {
    this.log(`tick ${time}`)
    for (const msg of messages){
      this.log(msg)
    }
    // randomly sends a Request.
    let req: CreatePromiseReq = {kind:"createPromise", id:"foo", timeout: Number.MAX_SAFE_INTEGER, tags: {"resonate:invoke":"default"}, iKey:"foo",}  // if we remove the Ikey a weird assertion happens
    return new Array<Message<RequestMsg>>(new Message(unicast("server"), req, {requ: true}))
  }
}

class Srvr extends Process{
  private server: Server;

  constructor(
    public readonly iaddr: string,
    public readonly gaddr: string[] = [],
  ) {
    super(iaddr, gaddr)
    this.server = new Server();
  }
  tick(time: number, messages: Message<RequestMsg>[]): Message<ResponseMsg | {
    recv: string;
    msg:
      | { kind: "invoke" | "resume"; id: string; counter: number }
      | { kind: "notify"; promise: DurablePromiseRecord };
  }>[] {

    let resps: Message<ResponseMsg | {
      recv: string;
      msg:
        | { kind: "invoke" | "resume"; id: string; counter: number }
        | { kind: "notify"; promise: DurablePromiseRecord };
    }>[] = new Array()

    this.log(`tick ${time}`)

    for (const msg of messages){
      this.log(msg.data.kind)
      switch (msg.data.kind) {
        case "createPromise":
          resps.push(msg.resp(anycast("w"), this.createPromise(msg.data)));
          break
        default:
          throw new Error(`Unsupported request kind: ${(msg.data as any).kind}`);
      }
      // append all responses and then return
    }
    // get msg to send.
    let step = this.server.step(time)
    let next = true
    let result: IteratorResult<{
      recv: string;
      msg:
        | { kind: "invoke" | "resume"; id: string; counter: number }
        | { kind: "notify"; promise: DurablePromiseRecord };
    }>

    do {
      result = step.next(next)
      if (!result.done){
        let url = new URL(result.value.recv)
        util.assert((url.protocol === "local:"))
        let target: Address
        if (url.username === "any" && url.host === "default"){
          target = anycast(url.username)
        } else {
          throw new Error(`not handled ${url}`)
        }
        resps.push(new Message(target, result.value))
        next = true
      }
    } while (!result.done)

    return resps
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



let s = new Simulator(0);

// Server
s.register(new Srvr("server"))

// Workers
s.register(new Worker("w1", ["w"]))

let i = 0
while (i <= 10) {
  s.tick();
  i++
}
