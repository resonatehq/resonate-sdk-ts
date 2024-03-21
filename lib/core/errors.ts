export enum ErrorCodes {
  UNKNOWN = 0,
  SERVER = 1,
  PAYLOAD = 2,
  FORBIDDEN = 3,
  NOT_FOUND = 4,
  ALREADY_EXISTS = 5,
  INVALID_STATE = 6,
  ENCODER = 7,
}

export class ResonateError extends Error {
  constructor(public readonly message: string) {
    super(message);
  }

  public static fromError(e: unknown): ResonateError {
    return e instanceof ResonateError ? e : new ResonateError("Unexpected error: " + e);
  }
}

export class ResonateStorageError extends ResonateError {
  constructor(
    public readonly code: ErrorCodes,
    message: string,
    public readonly cause?: any,
    public readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export class ResonateCanceled extends ResonateError {
  originalError: unknown;

  constructor(error: unknown) {
    super(`Resonate function canceled: ${typeof error === "string" ? error : "unknown reason"}`);
    this.originalError = error;
  }
}

export class ResonateTimedout extends ResonateError {
  timeout: number;

  constructor(timeout: number) {
    super(`Resonate function timedout at ${new Date(timeout).toISOString()}`);
    this.timeout = timeout;
  }
}

export class ResonateKilled extends ResonateError {
  originalError: unknown;

  constructor(error: unknown) {
    super(`Resonate function killed: ${error instanceof Error ? error.message : "unknown reason"}`);
    this.originalError = error;
  }
}
