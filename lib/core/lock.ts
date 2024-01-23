export interface ILock {
  tryAcquire(resourceId: string, processId: string, executionId: string, timeout: number | undefined): Promise<boolean>;
  releaseLock(resourceId: string, executionId: string): Promise<void>;
}

type WithHeartbeat<T> = T extends { heartbeat(processId: string, timeout: number): Promise<number> } ? T : never;

export type ILockRemote = ILock & WithHeartbeat<{ heartbeat(processId: string, timeout: number): Promise<number> }>;
