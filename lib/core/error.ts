export enum ErrorCodes {
  UNKNOWN = 0,
  SERVER = 1,
  PAYLOAD = 2,
  FORBIDDEN = 3,
  NOT_FOUND = 4,
  ALREADY_EXISTS = 5,
  INVALID_STATE = 6,
  ENCODER = 7,
  CANCELLED = 8,
  TIMEOUT = 9,
}

export class ResonateError extends Error {
  constructor(public readonly message: string) {
    super(message);
  }

  public static fromError(e: unknown): ResonateError {
    return e instanceof ResonateError ? e : new ResonateError("Unexpected error: " + e);
  }
}

export class ResonateServerError extends ResonateError {
  constructor(
    public readonly code: ErrorCodes,
    message: string,
    public readonly cause?: any,
    public readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export class ResonateLocalStoreError extends ResonateError {
  constructor(
    public readonly code: ErrorCodes,
    message: string,
    public readonly cause?: any,
    public readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

export class ResonateTestCrash extends ResonateError {
  constructor(prob: number) {
    super("Simulated failure with prob: " + prob);
  }
}

export class ResonateCancelled extends ResonateServerError {
  constructor(cause?: any) {
    super(ErrorCodes.CANCELLED, "Promise Cancelled", cause);
  }
}

export class ResonateTimeout extends ResonateServerError {
  constructor() {
    super(ErrorCodes.TIMEOUT, "Promise Timedout");
  }
}
