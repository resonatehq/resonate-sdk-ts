import {
  DurablePromise,
  PendingPromise,
  ResolvedPromise,
  RejectedPromise,
  CanceledPromise,
  TimedoutPromise,
  isPendingPromise,
  isResolvedPromise,
  isRejectedPromise,
  isCanceledPromise,
} from "../promise";
import { IPromiseStore } from "../store";
import { IEncoder } from "../encoder";
import { Base64Encoder } from "../encoders/base64";
import { ErrorCodes, ResonateError } from "../error";

export class LocalPromiseStore implements IPromiseStore {
  private readonly storeName = "promises";
  private db: IDBDatabase;

  private constructor(
    db: IDBDatabase,
    private encoder: IEncoder<string, string> = new Base64Encoder(),
  ) {
    this.db = db;
  }

  static async getInstance(encoder?: IEncoder<string, string>): Promise<LocalPromiseStore> {
    return new Promise<LocalPromiseStore>((resolve, reject) => {
      const request = indexedDB.open("resonateDB", 1);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        const db = request.result;
        resolve(new LocalPromiseStore(db, encoder));
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        db.createObjectStore("promises", { keyPath: "id" });
      };
    });
  }

  private async getObjectStore(): Promise<IDBObjectStore> {
    if (!this.db) {
      throw new ResonateError("Database not initialized", ErrorCodes.DATABASE);
    }

    const transaction = this.db.transaction(this.storeName, "readwrite");
    return transaction.objectStore(this.storeName);
  }

  async create(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
    timeout: number,
    tags: Record<string, string> | undefined,
  ): Promise<PendingPromise | ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    const tick = Date.now();
    this.transition(tick);

    const objectStore = await this.getObjectStore();
    const storedPromise: DurablePromise | undefined = await this.getPromiseById(objectStore, id);

    if (storedPromise) {
      if (strict && !isPendingPromise(storedPromise)) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      if (storedPromise.idempotencyKeyForCreate === undefined || ikey !== storedPromise.idempotencyKeyForCreate) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      return storedPromise;
    } else {
      const newPromise: PendingPromise = {
        state: "PENDING",
        id: id,
        timeout: timeout,
        param: {
          headers: headers ?? {},
          data: data !== undefined ? this.encode(data) : "",
        },
        value: undefined,
        createdOn: tick,
        completedOn: undefined,
        idempotencyKeyForCreate: ikey,
        idempotencyKeyForComplete: undefined,
        tags: tags,
      };

      await this.savePromise(objectStore, newPromise);
      return newPromise;
    }
  }

  async resolve(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    const tick = Date.now();
    this.transition(tick);

    const objectStore = await this.getObjectStore();
    const storedPromise: DurablePromise | undefined = await this.getPromiseById(objectStore, id);

    if (storedPromise) {
      if (strict && !isPendingPromise(storedPromise) && !isResolvedPromise(storedPromise)) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      if (isPendingPromise(storedPromise)) {
        // Create a new resolved promise
        const resolvedPromise: ResolvedPromise = {
          state: "RESOLVED",
          id: storedPromise.id,
          timeout: storedPromise.timeout,
          param: {
            headers: storedPromise.param.headers,
            data: storedPromise.param.data !== undefined ? this.encode(storedPromise.param.data) : "",
          },
          value: {
            headers: headers ?? {},
            data: data !== undefined ? this.encode(data) : "",
          },
          createdOn: storedPromise.createdOn,
          completedOn: tick,
          idempotencyKeyForCreate: storedPromise.idempotencyKeyForCreate,
          idempotencyKeyForComplete: ikey,
          tags: storedPromise.tags,
        };

        // Replace the existing promise with the new resolved promise
        await this.savePromise(objectStore, resolvedPromise);
        return resolvedPromise;
      }

      if (storedPromise.idempotencyKeyForComplete === undefined || ikey !== storedPromise.idempotencyKeyForComplete) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      return storedPromise;
    } else {
      throw new ResonateError("Not found", ErrorCodes.NOT_FOUND);
    }
  }

  async reject(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    const tick = Date.now();
    this.transition(tick);

    const objectStore = await this.getObjectStore();
    const storedPromise: DurablePromise | undefined = await this.getPromiseById(objectStore, id);

    if (storedPromise) {
      if (strict && !isPendingPromise(storedPromise) && !isRejectedPromise(storedPromise)) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      if (isPendingPromise(storedPromise)) {
        // Create a new rejected promise
        const rejectedPromise: RejectedPromise = {
          state: "REJECTED",
          id: storedPromise.id,
          timeout: storedPromise.timeout,
          param: {
            headers: storedPromise.param.headers,
            data: storedPromise.param.data !== undefined ? this.encode(storedPromise.param.data) : "",
          },
          value: {
            headers: headers ?? {},
            data: data !== undefined ? this.encode(data) : "",
          },
          createdOn: storedPromise.createdOn,
          completedOn: tick,
          idempotencyKeyForCreate: storedPromise.idempotencyKeyForCreate,
          idempotencyKeyForComplete: ikey,
          tags: storedPromise.tags,
        };

        // Replace the existing promise with the new rejected promise
        await this.savePromise(objectStore, rejectedPromise);
        return rejectedPromise;
      }

      if (storedPromise.idempotencyKeyForComplete === undefined || ikey !== storedPromise.idempotencyKeyForComplete) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      return storedPromise;
    } else {
      throw new ResonateError("Not found", ErrorCodes.NOT_FOUND);
    }
  }

  async cancel(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    const tick = Date.now();
    this.transition(tick);

    const objectStore = await this.getObjectStore();
    const storedPromise: DurablePromise | undefined = await this.getPromiseById(objectStore, id);

    if (storedPromise) {
      if (strict && !isPendingPromise(storedPromise) && !isCanceledPromise(storedPromise)) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      if (isPendingPromise(storedPromise)) {
        // Create a new canceled promise
        const canceledPromise: CanceledPromise = {
          state: "REJECTED_CANCELED",
          id: storedPromise.id,
          timeout: storedPromise.timeout,
          param: {
            headers: storedPromise.param.headers,
            data: storedPromise.param.data !== undefined ? this.encode(storedPromise.param.data) : "",
          },
          value: {
            headers: headers ?? {},
            data: data !== undefined ? this.encode(data) : "",
          },
          createdOn: storedPromise.createdOn,
          completedOn: tick,
          idempotencyKeyForCreate: storedPromise.idempotencyKeyForCreate,
          idempotencyKeyForComplete: ikey,
          tags: storedPromise.tags,
        };

        // Replace the existing promise with the new canceled promise
        await this.savePromise(objectStore, canceledPromise);
        return canceledPromise;
      }

      if (storedPromise.idempotencyKeyForComplete === undefined || ikey !== storedPromise.idempotencyKeyForComplete) {
        throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
      }

      return storedPromise;
    } else {
      throw new ResonateError("Not found", ErrorCodes.NOT_FOUND);
    }
  }

  async get(id: string): Promise<DurablePromise> {
    const objectStore = await this.getObjectStore();
    const storedPromise: DurablePromise | undefined = await this.getPromiseById(objectStore, id);

    if (storedPromise) {
      return storedPromise;
    }

    throw new ResonateError("Not found", ErrorCodes.NOT_FOUND);
  }

  private async getPromiseById(objectStore: IDBObjectStore, id: string): Promise<DurablePromise | undefined> {
    return new Promise<DurablePromise | undefined>((resolve, reject) => {
      const request = objectStore.get(id);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        const storedPromise = request.result as DurablePromise | undefined;
        resolve(storedPromise);
      };
    });
  }

  private async savePromise(objectStore: IDBObjectStore, promise: DurablePromise): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = objectStore.put(promise);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  private async transition(tick: number): Promise<void> {
    const objectStore = await this.getObjectStore();
    const cursorRequest = objectStore.openCursor();

    return new Promise<void>((resolve) => {
      cursorRequest.onsuccess = (event: Event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          const storedPromise = cursor.value as DurablePromise;

          if (isPendingPromise(storedPromise) && storedPromise.timeout <= tick) {
            const rejectedPromise: RejectedPromise = {
              state: "REJECTED",
              id: storedPromise.id,
              timeout: storedPromise.timeout,
              param: storedPromise.param,
              value: { headers: {}, data: "" },
              createdOn: storedPromise.createdOn,
              completedOn: storedPromise.timeout,
              idempotencyKeyForCreate: storedPromise.idempotencyKeyForCreate,
              idempotencyKeyForComplete: undefined,
              tags: storedPromise.tags,
            };

            // Delete the existing pending promise
            cursor.delete();

            // Save the new rejected promise
            this.savePromise(objectStore, rejectedPromise).then(() => {
              cursor.continue();
            });
          } else {
            cursor.continue();
          }
        } else {
          resolve();
        }
      };
    });
  }

  private encode(value: string): string {
    try {
      return this.encoder.encode(value);
    } catch (e: unknown) {
      throw new ResonateError("Encode error", ErrorCodes.ENCODER, e);
    }
  }

  private decode(value: string): string {
    try {
      return this.encoder.decode(value);
    } catch (e: unknown) {
      throw new ResonateError("Decode error", ErrorCodes.ENCODER, e);
    }
  }
}
