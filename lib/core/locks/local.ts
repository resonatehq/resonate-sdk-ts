import { ILock } from "../lock";

export class LocalLock implements ILock {
  private locks: Map<string, { processId: string; executionId: string }> = new Map();

  async tryAcquire(resourceId: string, processId: string, executionId: string, timeout?: number): Promise<boolean> {
    const lockKey = `${resourceId}-${executionId}`;
    if (!this.locks.has(lockKey)) {
      this.locks.set(lockKey, { processId, executionId });
      return true;
    } else {
      return false;
    }
  }

  async releaseLock(resourceId: string, executionId: string): Promise<void> {
    const lockKey = `${resourceId}-${executionId}`;
    this.locks.delete(lockKey);
  }
}
