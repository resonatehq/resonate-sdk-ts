import { ILock } from '../lock';

export class LocalLock implements ILock {
  private locks: Record<string, { pid: string }> = {};

  tryAcquire(id: string, pid: string): boolean {
    if (!this.locks[id]) {
      // Lock is available, acquire it
      this.locks[id] = { pid };
      return true;
    } else {
      // Lock is already acquired
      return false;
    }
  }

  release(id: string): void {
    if (this.locks[id]) {
      // Release the lock
      delete this.locks[id];
    } else {
      // Lock was not acquired
      throw new Error(`Lock with ID '${id}' not found.`);
    }
  }
}
