import { IStorage } from "../storage";
import { DurablePromise, isDurablePromise } from "../promise";
import { ResonateError, ErrorCodes } from "../error";

export class IndexedDbStorage implements IStorage {
  private dbName = "resonateDB";
  private readonly storeName = "promises";
  private db: Promise<IDBDatabase>;

  constructor(dbName: string, userDb?: IDBDatabase) {
    this.dbName = dbName;

    if (userDb) {
      this.db = Promise.resolve(userDb);
    } else {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);

        request.onerror = (event) => {
          reject(event);
        };

        request.onsuccess = () => {
          resolve(request.result);
        };

        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore(this.storeName, { keyPath: "id" });
        };
      });
    }
  }

  async rmw<P extends DurablePromise | undefined>(
    id: string,
    f: (promise: DurablePromise | undefined) => P,
  ): Promise<P> {
    const db = await this.getDb();
    const transaction = db.transaction(this.storeName, "readwrite");
    const objectStore = transaction.objectStore(this.storeName);

    const storedPromise: DurablePromise | undefined = await this.getPromiseById(objectStore, id);
    const resultPromise = f(storedPromise);

    if (resultPromise) {
      await this.savePromise(objectStore, resultPromise);
    }

    return resultPromise;
  }

  private async getDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        if (!isDurablePromise(request.result)) {
          throw new ResonateError(ErrorCodes.INVALID_STATE, "Invalid promise");
        }
        const db = request.result;
        resolve(db);
      };
    });
  }

  async getPromiseById(objectStore: IDBObjectStore, id: string): Promise<DurablePromise | undefined> {
    return new Promise<DurablePromise | undefined>(async (resolve, reject) => {
      if (!objectStore) {
        const db = await this.getDb();
        const transaction = db.transaction(this.storeName, "readonly");
        objectStore = transaction.objectStore(this.storeName);
      }

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

  async savePromise(objectStore: IDBObjectStore, promise: DurablePromise): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      if (!objectStore) {
        const db = await this.getDb();
        const transaction = db.transaction(this.storeName, "readwrite");
        objectStore = transaction.objectStore(this.storeName);
      }
      const request = objectStore.put(promise);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }
}