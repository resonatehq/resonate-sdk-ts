import type {
  CallbackRecord,
  ClaimTaskReq,
  CompletePromiseReq,
  CreateCallbackReq,
  CreatePromiseReq,
  DurablePromiseRecord,
  Network,
} from "./network/network";
import * as util from "./util";

import type { Callback } from "./types";

class PromiseCache extends Map<string, DurablePromiseRecord> {
  set(k: string, v: DurablePromiseRecord): this {
    util.assert(v.state !== "pending" || (this.get(k)?.state ?? "pending") === "pending", "promise already completed");
    return super.set(k, v);
  }
}

export class Handler {
  private network: Network;
  private promises: Map<string, DurablePromiseRecord> = new PromiseCache();
  private callbacks: Map<string, CallbackRecord> = new Map();

  constructor(network: Network, initialPromises?: DurablePromiseRecord[]) {
    this.network = network;

    for (const p of initialPromises ?? []) {
      this.promises.set(p.id, p);
    }
  }

  public createPromise(req: CreatePromiseReq, done: Callback<DurablePromiseRecord>): void {
    const promise = this.promises.get(req.id);
    if (promise) {
      done(false, promise);
      return;
    }

    this.network.send(req, (err, res) => {
      if (err) return done(err);
      util.assertDefined(res);

      this.promises.set(res.promise.id, res.promise);
      done(false, res.promise);
    });
  }

  public completePromise(req: CompletePromiseReq, done: Callback<DurablePromiseRecord>): void {
    const promise = this.promises.get(req.id);
    util.assertDefined(promise);

    if (promise.state !== "pending") {
      done(false, promise);
      return;
    }

    this.network.send(req, (err, res) => {
      if (err) return done(err);
      util.assertDefined(res);

      this.promises.set(res.promise.id, res.promise);
      done(false, res.promise);
    });
  }

  public createCallback(
    req: CreateCallbackReq,
    done: Callback<{ kind: "callback"; callback: CallbackRecord } | { kind: "promise"; promise: DurablePromiseRecord }>,
  ): void {
    const promise = this.promises.get(req.id);
    util.assertDefined(promise);

    if (promise.state !== "pending") {
      done(false, { kind: "promise", promise });
      return;
    }

    // TODO
    // const callback = this.callbacks.get(`${req.rootPromiseId}:${req.id}`);
    // if (callback) {
    //   done(false, { kind: "callback", callback });
    //   return;
    // }

    this.network.send(req, (err, res) => {
      if (err) return done(true);
      util.assertDefined(res);

      if (res.promise) {
        this.promises.set(res.promise.id, res.promise);
      }

      if (res.callback) {
        this.callbacks.set(`${req.rootPromiseId}:${req.id}`, res.callback);
      }

      done(
        false,
        res.callback ? { kind: "callback", callback: res.callback } : { kind: "promise", promise: res.promise },
      );
    });
  }

  public claimTask(req: ClaimTaskReq, done: Callback<DurablePromiseRecord>) {
    this.network.send(req, (err, res) => {
      if (err) return done(err);
      util.assertDefined(res);

      if (res.message.promises.root) {
        this.promises.set(res.message.promises.root.id, res.message.promises.root.data);
      }

      if (res.message.promises.leaf) {
        this.promises.set(res.message.promises.leaf.id, res.message.promises.leaf.data);
      }

      util.assertDefined(res.message.promises.root);
      done(false, res.message.promises.root.data);
    });
  }
}
