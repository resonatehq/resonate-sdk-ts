import { Simulator, Process, Message, unicast, anycast } from "./simulator";
import { CreatePromiseAndTaskReq } from "../src/network/network";
class Server extends Process {
  onInit() {


    this.bus.onMessage = (msg: Message<CreatePromiseAndTaskReq>) => {
      this.log("msg received ", msg)
    }
  }
}

class Worker extends Process {
  onInit() {
    let req: CreatePromiseAndTaskReq = {kind: "createPromiseAndTask", promise: {id: "foo", timeout: 1000}, task: {processId: this.iaddr, ttl: 50}}
    this.bus.requ(new Message(unicast("server"),req ), () => {
      this.log("worker to server sent")
    })
  }
}

let s = new Simulator(0);

// Server
s.register(new Server("server"));

// Worker
s.register(new Worker("p2", ["g2"]));

while (s.more()) {
  s.tick();
}
