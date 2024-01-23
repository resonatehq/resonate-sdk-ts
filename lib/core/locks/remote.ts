import { ErrorCodes, ResonateError } from "../error";
import { ILockRemote } from "../lock";
import { ILogger } from "../logger";
import { Logger } from "../loggers/logger";

export class RemoteLock implements ILockRemote {
  private url: string;

  constructor(
    url: string,
    private logger: ILogger = new Logger(),
  ) {
    this.url = url;
  }

  async tryAcquire(resourceId: string, processId: string, executionId: string, timeout?: number): Promise<boolean> {
    const lockRequest = {
      resource_id: resourceId,
      process_id: processId,
      execution_id: executionId,
      timeout: timeout || 0,
    };

    return call<boolean>(
      `${this.url}/locks/acquire`,
      (b: unknown): b is boolean => typeof b === "boolean",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(lockRequest),
      },
      this.logger,
    );
  }

  async releaseLock(resourceId: string, executionId: string): Promise<void> {
    const releaseLockRequest = {
      resource_id: resourceId,
      execution_id: executionId,
    };

    await call<void>(
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
  }

  async heartbeat(processId: string, timeout: number): Promise<number> {
    const heartbeatRequest = {
      process_id: processId,
      timeout: timeout,
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
