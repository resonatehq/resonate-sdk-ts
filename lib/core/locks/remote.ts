import { ErrorCodes, ResonateError } from "../error";
import { ILogger } from "../logger";
import { Logger } from "../loggers/logger";
import { ILockStore } from "../store";

export class RemoteLock implements ILockStore {
  private url: string;
  // simple lock counter - tryAcquire increments, release decrements
  // counter > 0 we call heartbeat api in a loop, setInterval
  private lockCounter: number = 0;
  private heartbeatInterval: NodeJS.Timer | null = null;

  constructor(
    url: string,
    private logger: ILogger = new Logger(),
  ) {
    this.url = url;
  }

  async tryAcquire(resourceId: string, processId: string, executionId: string): Promise<boolean> {
    const lockRequest = {
      resourceId: resourceId,
      processId: processId,
      executionId: executionId,
    };

    const acquired = call<boolean>(
      `${this.url}/locks/acquire`,
      (b: unknown): b is boolean => typeof b === "boolean",
      {
        method: "post",
        body: JSON.stringify(lockRequest),
      },
      this.logger,
    );

    if (await acquired) {
      this.lockCounter++;
      // Start the heartbeat if it's not already running
      if (this.lockCounter === 1) {
        this.startHeartbeat(processId);
      }
      return true;
    }
    return false;
  }

  async release(resourceId: string, executionId: string): Promise<void> {
    const releaseLockRequest = {
      resource_id: resourceId,
      execution_id: executionId,
    };

    call<void>(
      `${this.url}/locks/release`,
      (response: unknown): response is void => response === undefined,
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(releaseLockRequest),
      },
      this.logger,
    );

    this.lockCounter--;
    // Stop the heartbeat if there are no more locks
    if (this.lockCounter === 0) {
      this.stopHeartbeat();
    }
  }

  private startHeartbeat(processId: string): void {
    this.heartbeatInterval = setInterval(async () => {
      const locksAffected = await this.heartbeat(processId);
      if (locksAffected === 0) {
        this.stopHeartbeat();
      }
    }, 5000); // desired heartbeat interval (in ms)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval as any);
      this.heartbeatInterval = null;
    }
  }

  private async heartbeat(processId: string): Promise<number> {
    const heartbeatRequest = {
      process_id: processId,
      timeout: 0,
    };

    return call<number>(
      `${this.url}/locks/heartbeat`,
      (locksAffected: unknown): locksAffected is number => typeof locksAffected === "number",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(heartbeatRequest),
      },
      this.logger,
    );
  }
}

async function call<T>(
  url: string,
  guard: (b: unknown) => b is T,
  options: RequestInit,
  logger: ILogger,
  retries: number = 3,
): Promise<T> {
  let error: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, options);
      const body: unknown = await r.json();

      logger.debug("store", {
        req: {
          method: options.method,
          url: url,
          headers: options.headers,
          body: options.body,
        },
        res: {
          status: r.status,
          body: body,
        },
      });

      if (!r.ok) {
        switch (r.status) {
          case 400:
            throw new ResonateError(ErrorCodes.PAYLOAD, "Invalid request", body);
          case 403:
            throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request", body);
          case 404:
            throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found", body);
          case 409:
            throw new ResonateError(ErrorCodes.ALREADY_EXISTS, "Already exists", body);
          default:
            throw new ResonateError(ErrorCodes.SERVER, "Server error", body, true);
        }
      }

      if (!guard(body)) {
        throw new ResonateError(ErrorCodes.PAYLOAD, "Invalid response", body);
      }

      return body;
    } catch (e: unknown) {
      if (e instanceof ResonateError && !e.retryable) {
        throw e;
      } else {
        error = e;
      }
    }
  }

  throw ResonateError.fromError(error);
}
