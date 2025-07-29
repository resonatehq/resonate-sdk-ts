import { Server } from "../server";

import type {
  ClaimTaskReq,
  ClaimTaskRes,
  CompletePromiseReq,
  CompletePromiseRes,
  CompleteTaskReq,
  CompleteTaskRes,
  CreateCallbackReq,
  CreateCallbackRes,
  CreatePromiseAndTaskReq,
  CreatePromiseAndTaskRes,
  CreatePromiseReq,
  CreatePromiseRes,
  CreateScheduleReq,
  CreateScheduleRes,
  CreateSubscriptionReq,
  CreateSubscriptionRes,
  DeleteScheduleReq,
  DeleteScheduleRes,
  HeartbeatTasksReq,
  HeartbeatTasksRes,
  Network,
  ReadPromiseReq,
  ReadPromiseRes,
  ReadScheduleReq,
  ReadScheduleRes,
  RecvMsg,
  RequestMsg,
  ResponseMsg,
} from "./network";

export class LocalNetwork implements Network {
  private server: Server;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor(server: Server = new Server()) {
    this.server = server;
    this.timeoutId = undefined;
  }

  private enqueueNext(): void {
    clearTimeout(this.timeoutId);
    const n = this.server.next();

    if (n !== undefined) {
      this.timeoutId = setTimeout((): void => {
        const msgs = this.server.step();
        this.enqueueNext();
        this.recv(msgs);
      }, n);
    }
  }

  send(request: RequestMsg, callback: (timeout: boolean, response: ResponseMsg) => void): void {
    const response = this.server.process(request);
    clearTimeout(this.timeoutId);
    this.enqueueNext();
    callback(false, response);
  }

  recv(msg: any): void {
    const msgs = msg as RecvMsg[];
    for (const m of msgs) {
      this.onMessage?.(m);
    }
  }

  public onMessage?: (msg: RecvMsg) => void;
}
