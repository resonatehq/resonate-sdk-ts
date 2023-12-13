import {
	DurablePromise,
	PendingPromise,
	ResolvedPromise,
	RejectedPromise,
	CanceledPromise,
	TimedoutPromise,
	isPendingPromise,
  } from "../promise";
import { IPromiseStore } from "../store";
import { IEncoder } from "../encoder";
import { Base64Encoder } from "../encoders/base64";
import { ErrorCodes, ResonateError } from "../error";
import { IndexedDbStorage } from "../storages/memory"; // Import the IndexedDB storage

export class IndexedDBPromiseStore implements IPromiseStore {
	private storage: IndexedDbStorage; // Use IndexedDbStorage directly

	constructor(
		dbName: string,
		storage: IndexedDbStorage = new IndexedDbStorage(dbName),
		private encoder: IEncoder<string, string> = new Base64Encoder(),
	) {
		this.storage = storage;
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
		return this.storage.rmw(id, (promise) => {
		  if (promise) {
			if (strict && !isPendingPromise(promise)) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			if (promise.idempotencyKeyForCreate === undefined || ikey !== promise.idempotencyKeyForCreate) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			return promise;
		  } else {
			const newPromise: PendingPromise = {
			  state: "PENDING",
			  id: id,
			  timeout: timeout,
			  param: {
				headers: headers ?? {},
				data: data !== undefined ? this.encoder.encode(data) : "",
			  },
			  value: {
				headers: undefined,
				data: undefined,
			  },
			  createdOn: Date.now(),
			  completedOn: undefined,
			  idempotencyKeyForCreate: ikey,
			  idempotencyKeyForComplete: undefined,
			  tags: tags,
			};
	  
			// Use IndexedDbStorage's savePromise method directly
			this.storage.savePromise(undefined, newPromise);
			return newPromise;
		  }
		});
	}      

	async resolve(
		id: string,
		ikey: string | undefined,
		strict: boolean,
		headers: Record<string, string> | undefined,
		data: string | undefined,
	): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
		return this.storage.rmw(id, (promise) => {
		  if (promise) {
			if (strict && !isPendingPromise(promise)) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			if (promise.idempotencyKeyForComplete === undefined || ikey !== promise.idempotencyKeyForComplete) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			const newPromise: ResolvedPromise = {
			  state: "RESOLVED",
			  id: id,
			  timeout: promise.timeout,
			  param: promise.param,
			  value: {
				headers: headers ?? {},
				data: data !== undefined ? this.encoder.encode(data) : "",
			  },
			  createdOn: promise.createdOn,
			  completedOn: Date.now(),
			  idempotencyKeyForCreate: promise.idempotencyKeyForCreate,
			  idempotencyKeyForComplete: ikey,
			  tags: promise.tags,
			};
	  
			// Use IndexedDbStorage's savePromise method directly
			this.storage.savePromise(undefined, newPromise);
			return newPromise;
		  } else {
			throw new ResonateError("Promise not found", ErrorCodes.NOT_FOUND);
		  }
		});
	}

	// implement reject and cancel methods
	async reject(
		id: string,
		ikey: string | undefined,
		strict: boolean,
		headers: Record<string, string> | undefined,
		data: string | undefined,
	): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
		return this.storage.rmw(id, (promise) => {
		  if (promise) {
			if (strict && !isPendingPromise(promise)) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			if (promise.idempotencyKeyForComplete === undefined || ikey !== promise.idempotencyKeyForComplete) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			const newPromise: RejectedPromise = {
			  state: "REJECTED",
			  id: id,
			  timeout: promise.timeout,
			  param: promise.param,
			  value: {
				headers: headers ?? {},
				data: data !== undefined ? this.encoder.encode(data) : "",
			  },
			  createdOn: promise.createdOn,
			  completedOn: Date.now(),
			  idempotencyKeyForCreate: promise.idempotencyKeyForCreate,
			  idempotencyKeyForComplete: ikey,
			  tags: promise.tags,
			};
	  
			// Use IndexedDbStorage's savePromise method directly
			this.storage.savePromise(undefined, newPromise);
			return newPromise;
		  } else {
			throw new ResonateError("Promise not found", ErrorCodes.NOT_FOUND);
		  }
		});
	}

	async cancel(
		id: string,
		ikey: string | undefined,
		strict: boolean,
		headers: Record<string, string> | undefined,
		data: string | undefined,
	): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
		return this.storage.rmw(id, (promise) => {
		  if (promise) {
			if (strict && !isPendingPromise(promise)) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			if (promise.idempotencyKeyForComplete === undefined || ikey !== promise.idempotencyKeyForComplete) {
			  throw new ResonateError("Forbidden request", ErrorCodes.FORBIDDEN);
			}
	  
			const newPromise: CanceledPromise = {
			  state: "REJECTED_CANCELED",
			  id: id,
			  timeout: promise.timeout,
			  param: promise.param,
			  value: {
				headers: headers ?? {},
				data: data !== undefined ? this.encoder.encode(data) : "",
			  },
			  createdOn: promise.createdOn,
			  completedOn: Date.now(),
			  idempotencyKeyForCreate: promise.idempotencyKeyForCreate,
			  idempotencyKeyForComplete: ikey,
			  tags: promise.tags,
			};
	  
			// Use IndexedDbStorage's savePromise method directly
			this.storage.savePromise(undefined, newPromise);
			return newPromise;
		  } else {
			throw new ResonateError("Promise not found", ErrorCodes.NOT_FOUND);
		  }
		});
	}

	async get(id: string): Promise<DurablePromise> {
		const promise = await this.storage.rmw(id, (p) => p);
		if (promise) {
		  return promise;
		}
		throw new ResonateError("Not found", ErrorCodes.NOT_FOUND);
	}
}

  