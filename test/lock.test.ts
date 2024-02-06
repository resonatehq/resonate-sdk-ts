import { jest, describe, test, expect } from "@jest/globals";
import { Resonate, Context } from "../lib/resonate";
import { LocalLockStore, LocalStore } from "../lib/core/stores/local";
import { RemoteLockStore, RemoteStore } from "../lib/core/stores/remote";
import { Logger } from "../lib/core/loggers/logger";

jest.setTimeout(10000);

const sharedResource: string[] = [];

function write(context: Context, id: string, final: boolean) {
  return new Promise((resolve) => {
    sharedResource.push(id);

    if (final) {
      resolve(sharedResource);
    }
  });
}

describe("Lock Store Tests", () => {
  const useDurable = process.env.USE_DURABLE === "true";
  const url = process.env.RESONATE_URL || "http://localhost:8001";
  const lockStore = useDurable ? new RemoteLockStore(url, "process-id") : new LocalLockStore();

  const store = useDurable ? new RemoteStore(url, "process-id", new Logger()) : new LocalStore();
  const r1 = new Resonate({ store });
  const r2 = new Resonate({ store });

  r1.register("write", write, { eid: "a" });
  r2.register("write", write, { eid: "b" });

  // test("Lock guards shared resource", async () => {
  //   r1.run("write", "id", "a", false);
  //   const p2 = r2.run("write", "id2", "b", true);

  //   while (sharedResource.length === 0) {
  //     await new Promise((resolve) => setTimeout(resolve, 10));
  //   }
  //   expect(sharedResource.length).toBe(2);

  //   // release lock so p2 can run
  //   await store.locks.release("write/id", sharedResource[0]);

  //   const r = await p2;

  //   expect(sharedResource.length).toBe(2);
  //   expect(sharedResource).toContain("a");
  //   expect(sharedResource).toContain("b");
  //   expect(sharedResource).toEqual(r);
  // });

  test("Lock store behaves correctly when acquiring and releasing locks", async () => {
    const acquireResult = await lockStore.tryAcquire("resource-id-1", "execution-id-1");
    expect(acquireResult).toBe(true);

    if (useDurable) {
      // should get error 403
      await expect(lockStore.tryAcquire("resource-id-1", "execution-id-2")).rejects.toThrow();
    } else {
      const secondAcquireResult = await lockStore.tryAcquire("resource-id-1", "execution-id-2");
      expect(secondAcquireResult).toBe(false);
    }

    await lockStore.release("resource-id-1", "execution-id-1");
    await expect(lockStore.release("resource-id-1", "execution-id-1")).rejects.toThrow();
  });

  test("Lock expiration works as expected", async () => {
    if (!useDurable) {
      return;
    }

    // Acquire a lock with a short expiration time
    const acquireResult = await lockStore.tryAcquire("resource-id-3", "execution-id-1", 1000);
    expect(acquireResult).toBe(true);

    // Wait for the lock to expire
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Assuming lockExpiry is 60000

    // Attempt to release the expired lock, should fail
    await expect(lockStore.release("resource-id-3", "execution-id-1")).rejects.toThrow();
  });

  test("Attempt to release a lock without acquiring it", async () => {
    const nonAcquiredResourceId = "non-acquired-resource-id";
    const nonAcquiredExecutionId = "non-acquired-execution-id";

    await expect(lockStore.release(nonAcquiredResourceId, nonAcquiredExecutionId)).rejects.toThrow();
  });
});
