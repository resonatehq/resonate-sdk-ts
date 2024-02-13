import { jest, describe, test, expect } from "@jest/globals";
import { Resonate, Context } from "../lib/resonate";
import { LocalStore } from "../lib/core/stores/local";
import { RemoteLockStore, RemoteStore } from "../lib/core/stores/remote";
import { Logger } from "../lib/core/loggers/logger";

jest.setTimeout(50000);

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

  const store = useDurable ? new RemoteStore(url, "process-id", new Logger()) : new LocalStore();
  const r1 = new Resonate({ store });
  const r2 = new Resonate({ store });

  r1.register("write", write, r1.options({ eid: "a", timeout: 5000 }));
  r2.register("write", write, r2.options({ eid: "b", timeout: 5000 }));

  test("Lock guards shared resource", async () => {
    expect(sharedResource.length).toBe(0);

    r1.run("write", "id", "a", false);
    const p2 = r2.run("write", "id2", "b", true);

    while (sharedResource.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sharedResource.length).toBe(2);

    try {
      // release lock so p2 can run
      await store.locks.release("write/id", sharedResource[0]);
    } catch (e) {
      // continue even if lock is not released
      console.error(e);
    }
    // try but not fail
    const r = await p2;

    expect(sharedResource.length).toBe(2);
    expect(sharedResource).toContain("a");
    expect(sharedResource).toContain("b");
    expect(sharedResource).toEqual(r);
  });

  test("Lock store behaves correctly when acquiring and releasing locks", async () => {
    const acquireResult = await store.locks.tryAcquire("resource-id-1", "execution-id-1");
    expect(acquireResult).toBe(true);

    await expect(store.locks.tryAcquire("resource-id-1", "execution-id-2")).rejects.toThrow();

    await store.locks.release("resource-id-1", "execution-id-1");
    await expect(store.locks.release("resource-id-1", "execution-id-1")).rejects.toThrow();
  });

  test("Lock expiration works as expected", async () => {
    if (!useDurable) {
      return;
    }

    // Acquire a lock with a short expiration time
    const remoteLockStore = new RemoteLockStore(url, "process-id", new Logger(), 1000);
    const acquireResult = await remoteLockStore.tryAcquire("resource-id-3", "execution-id-1");
    expect(acquireResult).toBe(true);

    // Wait for the lock to expire
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Assuming lockExpiry is 60000

    // Attempt to release the expired lock, should fail
    await expect(remoteLockStore.release("resource-id-3", "execution-id-1")).rejects.toThrow();
  });

  test("Attempt to release a lock without acquiring it", async () => {
    const nonAcquiredResourceId = "non-acquired-resource-id";
    const nonAcquiredExecutionId = "non-acquired-execution-id";

    await expect(store.locks.release(nonAcquiredResourceId, nonAcquiredExecutionId)).rejects.toThrow();
  });

  test("Lock Store: Acquire lock that exists", async () => {
    // register a lock
    const resourceId = "existing-resource-id";
    const executionId = "existing-execution-id";

    // Acquire the lock
    const acquireResult = await store.locks.tryAcquire(resourceId, executionId);
    expect(acquireResult).toBe(true);

    // Attempt to acquire the lock again, should succeed
    const secondAcquireResult = await store.locks.tryAcquire(resourceId, executionId);
    expect(secondAcquireResult).toBe(true);

    // Release the lock to clean up
    await store.locks.release(resourceId, executionId);
  });

  test("Lock Store: Acquire lock that exists with different executionId", async () => {
    const resourceId = "existing-resource-id";
    const executionId1 = "existing-execution-id-1";
    const executionId2 = "existing-execution-id-2";

    // Acquire the lock with executionId1
    const acquireResult1 = await store.locks.tryAcquire(resourceId, executionId1);
    expect(acquireResult1).toBe(true);

    // Attempt to acquire the lock with executionId2, should fail
    await expect(store.locks.tryAcquire(resourceId, executionId2)).rejects.toThrow();

    // Release the lock to clean up
    await store.locks.release(resourceId, executionId1);
  });

  test("Lock Store: Release lock that exists with same executionId", async () => {
    const resourceId = "existing-resource-id";
    const executionId = "existing-execution-id";

    // Acquire the lock
    await store.locks.tryAcquire(resourceId, executionId);

    // Release the lock, should succeed
    await store.locks.release(resourceId, executionId);
  });

  test("Lock Store: Release lock that exists with different executionId", async () => {
    const resourceId = "existing-resource-id";
    const executionId1 = "existing-execution-id-1";
    const executionId2 = "existing-execution-id-2";

    // Acquire the lock with executionId1
    await store.locks.tryAcquire(resourceId, executionId1);

    // Attempt to release the lock with executionId2, should fail
    await expect(store.locks.release(resourceId, executionId2)).rejects.toThrow();

    // Release the lock to clean up
    await store.locks.release(resourceId, executionId1);
  });

  test("Lock Store: Release lock that does not exist", async () => {
    const nonExistingResourceId = "non-existing-resource-id";
    const nonExistingExecutionId = "non-existing-execution-id";

    // Attempt to release a lock that does not exist, should fail
    await expect(store.locks.release(nonExistingResourceId, nonExistingExecutionId)).rejects.toThrow();
  });
});
