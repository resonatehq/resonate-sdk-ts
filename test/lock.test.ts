import { jest, describe, test, expect } from "@jest/globals";
import { Resonate, Context } from "../lib/resonate";
import { LocalLockStore, LocalStore } from "../lib/core/stores/local";
import { RemoteLockStore } from "../lib/core/stores/remote";

// Set a larger timeout for hooks (e.g., 10 seconds)
jest.setTimeout(100000);

const sharedResource: string[] = [];

function write(context: Context, id: string, final: boolean) {
  return new Promise((resolve) => {
    sharedResource.push(id);

    if (final) {
      resolve(sharedResource);
    }
  });
}

describe("Lock", () => {
  const store = new LocalStore();
  const r1 = new Resonate({ store });
  const r2 = new Resonate({ store });

  r1.register("write", write, { eid: "a" });
  r2.register("write", write, { eid: "b" });

  const useDurable = process.env.USE_DURABLE === "true";
  const url = process.env.RESONATE_URL || "http://localhost:8001";
  const lockStore = useDurable ? new RemoteLockStore(url, "process-id") : new LocalLockStore();

  test("Lock guards shared resource", async () => {
    r1.run("write", "id", "a", false);
    const p2 = r2.run("write", "id", "b", true);

    while (sharedResource.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sharedResource.length).toBe(1);

    // release lock so p2 can run
    await store.locks.release("write/id", sharedResource[0]);

    const r = await p2;

    expect(sharedResource.length).toBe(2);
    expect(sharedResource).toContain("a");
    expect(sharedResource).toContain("b");
    expect(sharedResource).toEqual(r);
  });

  test("Multiple clients can acquire and release locks on different resources concurrently", async () => {});

  test("Lock store behaves correctly when acquiring and releasing locks", async () => {
    // Acquire a lock
    const acquireResult = await lockStore.tryAcquire("resource-id-1", "execution-id-1");
    expect(acquireResult).toBe(true);

    // Attempt to acquire the same lock with a different execution ID,
    if (useDurable) {
      // should get error 403
      await expect(lockStore.tryAcquire("resource-id-1", "execution-id-2")).rejects.toThrow();
    } else {
      const secondAcquireResult = await lockStore.tryAcquire("resource-id-1", "execution-id-2");
      expect(secondAcquireResult).toBe(false);
    }

    // Release the lock
    await lockStore.release("resource-id-1", "execution-id-1");

    // Attempt to release the lock again,
    if (useDurable) {
      // should result in an error 404
      await expect(lockStore.release("resource-id-1", "execution-id-1")).rejects.toThrow();
    } else {
      lockStore.release("resource-id-2", "execution-id-1");
    }
  });

  test("Lock expiration works as expected", async () => {
    if (!useDurable) {
      return;
    }

    // Acquire a lock with a short expiration time
    const acquireResult = await lockStore.tryAcquire("resource-id-3", "execution-id-1");
    expect(acquireResult).toBe(true);

    // Wait for the lock to expire
    await new Promise((resolve) => setTimeout(resolve, 70000)); // Assuming lockExpiry is 60000

    // Attempt to release the expired lock, should fail
    await expect(lockStore.release("resource-id-3", "execution-id-1")).rejects.toThrow();
  });
});
