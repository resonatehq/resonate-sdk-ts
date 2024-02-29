import { Execution } from "./execution";
import { FutureResolvers } from "./future";

import { IStore } from "./core/store";
import { DurablePromise } from "./core/promise";

export async function resolveDurablePromise(store: IStore, execution: Execution<any>, value: any) {
  try {
    const promise = await store.promises.resolve(execution.id, execution.id, false, undefined, JSON.stringify(value));
    syncFutureToDurablePromise(promise, execution.resolvers);
  } catch (error) {
    execution.kill(error);
  }
}

export async function rejectDurablePromise(store: IStore, execution: Execution<any>, error: unknown) {
  try {
    const promise = await store.promises.reject(execution.id, execution.id, false, undefined, JSON.stringify(error));
    syncFutureToDurablePromise(promise, execution.resolvers);
  } catch (error) {
    execution.kill(error);
  }
}

export function syncFutureToDurablePromise(promise: DurablePromise, resolvers: FutureResolvers<any>) {
  switch (promise.state) {
    case "RESOLVED":
      resolvers.resolve(promise.value.data ? JSON.parse(promise.value.data) : undefined);
      break;
    case "REJECTED":
      resolvers.reject(promise.value.data ? JSON.parse(promise.value.data) : undefined);
      break;
    case "REJECTED_CANCELED":
      resolvers.cancel("canceled");
      break;
    case "REJECTED_TIMEDOUT":
      resolvers.timeout("timedout");
      break;
    default:
      break;
  }
}
