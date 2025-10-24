export type ResonateServerError = {
  code: number;
  message: string;
  details?: any[];
};

export class ResonateError extends Error {
  code: string;
  type: string;
  next: string;
  href: string;
  retriable: boolean;
  shouldDrop: boolean;
  serverError?: ResonateServerError;

  constructor(
    code: string,
    type: string,
    mesg: string,
    {
      next = "n/a",
      cause,
      retriable = false,
      shouldDrop = false,
      serverError,
    }: {
      next?: string;
      cause?: any;
      retriable?: boolean;
      shouldDrop?: boolean;
      serverError?: ResonateServerError;
    } = {},
  ) {
    super(mesg, { cause });

    this.name = "ResonateError";
    this.code = code;
    this.type = type;
    this.next = next;
    this.href = `https://rn8.io/e/11${code}`; // 11 is the typescript sdk code
    this.retriable = retriable;
    this.shouldDrop = shouldDrop;
    this.serverError = serverError;
  }

  log(verbose: boolean) {
    console.error(`${this.type}. ${this.message}. ${this.next}. (See ${this.href} for more information)`);

    if (verbose) {
      console.error(this);
    }
  }
}

export default {
  REGISTRY_VERSION_INVALID: (v: number) => {
    return new ResonateError("00", "Registry", `Function version must be greater than zero (${v} provided)`);
  },
  REGISTRY_NAME_REQUIRED: () => {
    return new ResonateError("01", "Registry", "Function name is required");
  },
  REGISTRY_FUNCTION_ALREADY_REGISTERED: (f: string, v: number, u?: string) => {
    const under = u ? ` under '${u}'` : "";
    return new ResonateError("02", "Registry", `Function '${f}' (version ${v}) is already registered${under}`);
  },
  REGISTRY_FUNCTION_NOT_REGISTERED: (f: string, v: number) => {
    const version = v > 0 ? ` (version ${v})` : "";
    return new ResonateError("03", "Registry", `Function '${f}'${version} is not registered`, {
      next: "Will drop",
      shouldDrop: true,
    });
  },
  DEPENDENCY_ALREADY_REGISTERED: (d: string) => {
    return new ResonateError("04", "Dependencies", `Dependency '${d}' is already registered`);
  },
  DEPENDENCY_NOT_REGISTERED: (d: string) => {
    return new ResonateError("05", "Dependencies", `Dependency '${d}' is not registered`, { next: "Will drop" });
  },
  ENCODING_ARGS_UNENCODEABLE: (f: string, c: any) => {
    return new ResonateError("06", "Encoding", `Argument(s) for function '${f}' cannot be encoded`, {
      next: "Will drop",
      cause: c,
    });
  },
  ENCODING_ARGS_UNDECODEABLE: (f: string, c: any) => {
    return new ResonateError("07", "Encoding", `Argument(s) for function '${f}' cannot be decoded`, {
      next: "Will drop",
      cause: c,
    });
  },
  ENCODING_RETV_UNENCODEABLE: (f: string, c: any) => {
    return new ResonateError("08", "Encoding", `Return value from function '${f}' cannot be encoded`, {
      next: "Will drop",
      cause: c,
    });
  },
  ENCODING_RETV_UNDECODEABLE: (f: string, c: any) => {
    return new ResonateError("09", "Encoding", `Return value from function '${f}' cannot be decoded`, {
      next: "Will drop",
      cause: c,
    });
  },
  SERVER_ERROR: (m: any, r?: boolean, e?: ResonateServerError) => {
    return new ResonateError("99", "Server", m, { retriable: r, serverError: e });
  },
};
