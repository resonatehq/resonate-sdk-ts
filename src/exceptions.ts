export class ResonateError extends Error {
  code: string;
  type: string;
  next: string;
  href: string;

  constructor(code: string, type: string, mesg: string, next = "n/a") {
    super(mesg);
    this.name = "ResonateError";
    this.code = code;
    this.type = type;
    this.next = next;
    this.href = `https://rn8.io/e/${code}`;
  }

  log() {
    console.error(`${this.type}. ${this.message}. ${this.next}. (See ${this.href} for more information)`);
  }
}

export default {
  1: (v: number) => {
    return new ResonateError("01", "Registry", `Function version must be greater than zero (${v} provided)`);
  },
  2: () => {
    return new ResonateError("02", "Registry", "Function name is required");
  },
  3: (f: string, v: number, u?: string) => {
    const under = u ? ` under '${u}'` : "";
    return new ResonateError("03", "Registry", `Function '${f}' (version ${v}) is already registered${under}`);
  },
  4: (f: string, v: number) => {
    const version = v > 0 ? ` (version ${v})` : "";
    return new ResonateError("04", "Registry", `Function '${f}'${version} is not registered`, "Will drop");
  },
  // 3: (d: string) => new ResonateError("03", "Local", `Dependency '${d}' is already registered`),
  // 4: (d: string) => new ResonateError("04", "Local", `Dependency '${d}' is not registered`, "Will drop"),
  // 5: (p: string) => new ResonateError("05", "Store", `Promise '${p}' not found`),
  // 6: (f: string) => new ResonateError("06", "Store", `Argument(s) for function '${f}' cannot be encoded`),
  // 7: (f: string) => new ResonateError("07", "Store", `Argument(s) for function '${f}' cannot be decoded`),
  // 8: (f: string) => new ResonateError("08", "Store", `Return value from function '${f}' cannot be encoded`),
  // 9: (f: string) => new ResonateError("09", "Store", `Return value from function '${f}' cannot be decoded`),
};
