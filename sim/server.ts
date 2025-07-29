import type { RecvMsg, RequestMsg, ResponseMsg } from "../src/network/network";
import { Server } from "../src/server";
import { Message, Process, anycast } from "./simulator";

export class ServerProcess extends Process {
  server: Server = new Server();

  tick(time: number, messages: Message<RequestMsg>[]): Message<ResponseMsg | RecvMsg>[] {
    this.log(messages);
    const responses: Message<ResponseMsg | RecvMsg>[] = [];

    for (const message of messages) {
      if (message.isRequest()) {
        responses.push(message.resp(this.server.process(message.data, time)));
      }
    }
    const taskMgs = this.server.step(time);
    for (const message of taskMgs) {
      // TODO: THE TASK MUST LET US KNOW WHERE IT WANTST TO GO :warning:
      const msg = new Message<RecvMsg>(anycast("worker"), message);
      responses.push(msg);
    }

    return responses;
  }
}
