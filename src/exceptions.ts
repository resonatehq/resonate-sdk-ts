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
  PromiseNotFound: (p: string) => new ResonateError("01", "?", `Dependency 'Promise '${p}' not found`),
  FunctionRegistered: (f: string) => new ResonateError("02", "Local", `Function '${f}' is already registered`),
  FunctionNotRegistered: (f: string) =>
    new ResonateError("03", "Local", `Function '${f}' is not registered`, "Will drop"),
  DependencyRegistered: (d: string) => new ResonateError("04", "Local", `Dependency '${d}' is already registered`),
  DependencyNotRegistered: (d: string) =>
    new ResonateError("05", "Local", `Dependency '${d}' is not registered`, "Will drop"),
  ArgumentNotEncodeable: (f: string) =>
    new ResonateError("06", "?", `Argument(s) for function '${f}' cannot be encoded`),
  ArgumentNotDecodeable: (f: string) =>
    new ResonateError("07", "?", `Argument(s) for function '${f}' cannot be decoded`),
  ReturnValueNotEncodeable: (f: string) =>
    new ResonateError("08", "?", `Return value from function '${f}' cannot be encoded`),
  ReturnValueNotDecodeable: (f: string) =>
    new ResonateError("09", "?", `Return value from function '${f}' cannot be decoded`),
};
