export interface ILock {
    tryAcquire(id: string, pid: string): boolean;
    release(id: string): void;
}
