var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/clock.ts
class WallClock {
  now() {
    return Date.now();
  }
}
// src/exceptions.ts
class ResonateError extends Error {
  code;
  type;
  next;
  href;
  retriable;
  serverError;
  constructor(code, type, mesg, {
    next = "n/a",
    cause,
    retriable = false,
    serverError
  } = {}) {
    super(mesg, { cause });
    this.name = "ResonateError";
    this.code = code;
    this.type = type;
    this.next = next;
    this.href = `https://rn8.io/e/11${code}`;
    this.retriable = retriable;
    this.serverError = serverError;
  }
  log(verbose) {
    console.error(`${this.type}. ${this.message}. ${this.next}. (See ${this.href} for more information)`);
    if (verbose) {
      console.error(this);
    }
  }
}
var exceptions_default = {
  REGISTRY_VERSION_INVALID: (v) => {
    return new ResonateError("00", "Registry", `Function version must be greater than zero (${v} provided)`);
  },
  REGISTRY_NAME_REQUIRED: () => {
    return new ResonateError("01", "Registry", "Function name is required");
  },
  REGISTRY_FUNCTION_ALREADY_REGISTERED: (f, v, u) => {
    const under = u ? ` under '${u}'` : "";
    return new ResonateError("02", "Registry", `Function '${f}' (version ${v}) is already registered${under}`);
  },
  REGISTRY_FUNCTION_NOT_REGISTERED: (f, v) => {
    const version = v > 0 ? ` (version ${v})` : "";
    return new ResonateError("03", "Registry", `Function '${f}'${version} is not registered`, {
      next: "Will drop"
    });
  },
  DEPENDENCY_ALREADY_REGISTERED: (d) => {
    return new ResonateError("04", "Dependencies", `Dependency '${d}' is already registered`);
  },
  DEPENDENCY_NOT_REGISTERED: (d) => {
    return new ResonateError("05", "Dependencies", `Dependency '${d}' is not registered`, {
      next: "Will drop"
    });
  },
  ENCODING_ARGS_UNENCODEABLE: (f, c) => {
    return new ResonateError("06", "Encoding", `Argument(s) for function '${f}' cannot be encoded`, {
      next: "Will drop",
      cause: c
    });
  },
  ENCODING_ARGS_UNDECODEABLE: (f, c) => {
    return new ResonateError("07", "Encoding", `Argument(s) for function '${f}' cannot be decoded`, {
      next: "Will drop",
      cause: c
    });
  },
  ENCODING_RETV_UNENCODEABLE: (f, c) => {
    return new ResonateError("08", "Encoding", `Return value from function '${f}' cannot be encoded`, {
      next: "Will drop",
      cause: c
    });
  },
  ENCODING_RETV_UNDECODEABLE: (f, c) => {
    return new ResonateError("09", "Encoding", `Return value from function '${f}' cannot be decoded`, {
      next: "Will drop",
      cause: c
    });
  },
  PANIC: (src, msg) => {
    src = src.charAt(0).toUpperCase() + src.slice(1);
    msg = msg ? `: ${msg}` : "";
    return new ResonateError("98", "Panic", `${src}${msg}`, {
      next: "Will drop"
    });
  },
  SERVER_ERROR: (m, r, e) => {
    return new ResonateError("99", "Server", m, { retriable: r, serverError: e });
  }
};

// src/retries.ts
class Constant {
  static type = "constant";
  delay;
  maxRetries;
  constructor({ delay = 1000, maxRetries = Number.MAX_SAFE_INTEGER } = {}) {
    this.delay = delay;
    this.maxRetries = maxRetries;
  }
  next(attempt) {
    if (attempt < 0) {
      throw new Error("attempt must be greater than or equal to 0");
    }
    if (attempt > this.maxRetries) {
      return null;
    }
    if (attempt === 0) {
      return 0;
    }
    return this.delay;
  }
  encode() {
    return {
      type: "constant",
      data: { delay: this.delay, maxRetries: this.maxRetries }
    };
  }
}

class Exponential {
  static type = "exponential";
  delay;
  maxRetries;
  factor;
  maxDelay;
  constructor({
    delay = 1000,
    factor = 2,
    maxRetries = Number.MAX_SAFE_INTEGER,
    maxDelay = 30000
  } = {}) {
    this.delay = delay;
    this.factor = factor;
    this.maxRetries = maxRetries;
    this.maxDelay = maxDelay;
  }
  next(attempt) {
    if (attempt < 0) {
      throw new Error("attempt must be greater than or equal to 0");
    }
    if (attempt > this.maxRetries) {
      return null;
    }
    if (attempt === 0) {
      return 0;
    }
    return Math.min(this.delay * this.factor ** attempt, this.maxDelay);
  }
  encode() {
    return {
      type: "exponential",
      data: { delay: this.delay, factor: this.factor, maxRetries: this.maxRetries, maxDelay: this.maxDelay }
    };
  }
}

class Linear {
  static type = "linear";
  delay;
  maxRetries;
  constructor({ delay = 1000, maxRetries = Number.MAX_SAFE_INTEGER } = {}) {
    this.delay = delay;
    this.maxRetries = maxRetries;
  }
  next(attempt) {
    if (attempt < 0) {
      throw new Error("attempt must be greater than or equal to 0");
    }
    if (attempt > this.maxRetries) {
      return null;
    }
    return this.delay * attempt;
  }
  encode() {
    return {
      type: "linear",
      data: { delay: this.delay, maxRetries: this.maxRetries }
    };
  }
}

class Never {
  static type = "never";
  next(attempt) {
    if (attempt < 0) {
      throw new Error("attempt must be greater than or equal to 0");
    }
    return attempt === 0 ? 0 : null;
  }
  encode() {
    return {
      type: "never",
      data: {}
    };
  }
}

// src/options.ts
var RESONATE_OPTIONS = Symbol("ResonateOptions");

class OptionsBuilder {
  match;
  idPrefix;
  constructor({ match, idPrefix }) {
    this.match = (target) => isUrl(target) ? target : match(target);
    this.idPrefix = idPrefix;
  }
  build({
    id = undefined,
    retryPolicy = undefined,
    tags = {},
    target = "default",
    timeout = 24 * HOUR,
    version = 0
  } = {}) {
    id = id ? `${this.idPrefix}${id}` : id;
    return new Options({ id, retryPolicy, tags, target: this.match(target), timeout, version });
  }
}

class Options {
  id;
  tags;
  target;
  timeout;
  version;
  retryPolicy;
  [RESONATE_OPTIONS] = true;
  constructor({
    id = undefined,
    retryPolicy = undefined,
    tags = {},
    target = "default",
    timeout = 24 * HOUR,
    version = 0
  }) {
    this.id = id;
    this.tags = tags;
    this.target = target;
    this.timeout = timeout;
    this.version = version;
    this.retryPolicy = retryPolicy;
  }
}

// src/util.ts
var SEC = 1000;
var MIN = 60 * SEC;
var HOUR = 60 * MIN;
function assert(cond, msg) {
  if (cond)
    return;
  console.assert(cond, "Assertion Failed: %s", msg);
  console.trace();
  if (typeof process !== "undefined" && process.versions.node) {
    process.exit(1);
  }
}
function assertDefined(val) {
  assert(val !== null && val !== undefined, "value must not be null");
}
function isGeneratorFunction(func) {
  const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
  const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
  return func instanceof GeneratorFunction || func instanceof AsyncGeneratorFunction;
}
function isOptions(obj) {
  return typeof obj === "object" && obj !== null && RESONATE_OPTIONS in obj;
}
function isMessageSource(v) {
  return typeof v === "object" && v !== null && "recv" in v && typeof v.recv === "function";
}
function splitArgsAndOpts(args, defaults) {
  const opts = isOptions(args.at(-1)) ? args.pop() : {};
  return [args, { ...defaults, ...opts }];
}
function isUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  return btoa(String.fromCharCode(...bytes));
}
function base64Decode(str) {
  const bytes = Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const jsonStr = new TextDecoder().decode(bytes);
  return jsonStr;
}
function getCallerInfo() {
  const err = new Error;
  if (!err.stack)
    return "";
  const stack = err.stack.split(`
`);
  const callerLine = stack?.[3];
  return callerLine.trim();
}
function once(fn) {
  let called = false;
  return () => {
    assert(!called, "Function can only be called once");
    called = true;
    return fn();
  };
}

// src/context.ts
class LFI {
  id;
  func;
  args;
  version;
  retryPolicy;
  createReq;
  constructor(id, func, args, version, retryPolicy, createReq) {
    this.id = id;
    this.func = func;
    this.args = args;
    this.version = version;
    this.retryPolicy = retryPolicy;
    this.createReq = createReq;
  }
  *[Symbol.iterator]() {
    const v = yield this;
    assert(v instanceof Future, "expected future");
    return v;
  }
}

class LFC {
  id;
  func;
  args;
  version;
  retryPolicy;
  createReq;
  constructor(id, func, args, version, retryPolicy, createReq) {
    this.id = id;
    this.func = func;
    this.args = args;
    this.version = version;
    this.retryPolicy = retryPolicy;
    this.createReq = createReq;
  }
  *[Symbol.iterator]() {
    const v = yield this;
    assert(!(v instanceof Future), "expected value");
    return v;
  }
}

class RFI {
  id;
  func;
  version;
  createReq;
  mode;
  constructor(id, func, version, createReq, mode = "attached") {
    this.id = id;
    this.func = func;
    this.version = version;
    this.createReq = createReq;
    this.mode = mode;
  }
  *[Symbol.iterator]() {
    const v = yield this;
    assert(v instanceof Future, "expected future");
    return v;
  }
}

class RFC {
  id;
  func;
  version;
  createReq;
  mode = "attached";
  constructor(id, func, version, createReq) {
    this.id = id;
    this.func = func;
    this.version = version;
    this.createReq = createReq;
  }
  *[Symbol.iterator]() {
    const v = yield this;
    assert(!(v instanceof Future), "expected value");
    return v;
  }
}

class DIE {
  condition;
  error;
  constructor(condition, error) {
    this.condition = condition;
    this.error = error;
  }
  *[Symbol.iterator]() {
    yield this;
    return;
  }
}

class Future {
  id;
  value;
  state;
  mode;
  constructor(id, state, value, mode = "attached") {
    this.id = id;
    this.value = value;
    this.state = state;
    this.mode = mode;
  }
  getValue() {
    if (!this.value) {
      throw new Error("Future is not ready");
    }
    if (this.value.kind === "value") {
      return this.value.value;
    }
    throw this.value.error;
  }
  *[Symbol.iterator]() {
    yield this;
    assertDefined(this.value);
    assert(this.value.kind === "value", "The value must be and ok result at this point.");
    return this.getValue();
  }
}

class InnerContext {
  id;
  info;
  func;
  retryPolicy;
  originId;
  branchId;
  parentId;
  clock;
  span;
  registry;
  dependencies;
  optsBuilder;
  seq = 0;
  run = this.lfc.bind(this);
  rpc = this.rfc.bind(this);
  beginRun = this.lfi.bind(this);
  beginRpc = this.rfi.bind(this);
  constructor({
    id,
    oId = id,
    bId = id,
    pId = id,
    func,
    clock,
    registry,
    dependencies,
    optsBuilder,
    timeout,
    version,
    retryPolicy,
    span
  }) {
    this.id = id;
    this.originId = oId;
    this.branchId = bId;
    this.parentId = pId;
    this.func = func;
    this.clock = clock;
    this.registry = registry;
    this.dependencies = dependencies;
    this.optsBuilder = optsBuilder;
    this.retryPolicy = retryPolicy;
    this.span = span;
    this.info = {
      attempt: 1,
      timeout,
      version
    };
  }
  child({
    id,
    func,
    timeout,
    version,
    retryPolicy,
    span
  }) {
    return new InnerContext({
      id,
      oId: this.originId,
      bId: this.branchId,
      pId: this.id,
      func,
      clock: this.clock,
      registry: this.registry,
      dependencies: this.dependencies,
      optsBuilder: this.optsBuilder,
      timeout,
      version,
      retryPolicy,
      span
    });
  }
  lfi(funcOrName, ...args) {
    const [argu, opts] = splitArgsAndOpts(args, this.options());
    const registered = this.registry.get(funcOrName, opts.version);
    if (typeof funcOrName === "string" && !registered) {
      return new DIE(true, exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(funcOrName, opts.version));
    }
    const idChanged = opts.id !== undefined;
    const id = idChanged ? opts.id : this.seqid();
    this.seq++;
    const func = registered ? registered.func : funcOrName;
    const version = registered ? registered.version : 1;
    return new LFI(id, func, argu, version, opts.retryPolicy ?? (isGeneratorFunction(func) ? new Never : new Exponential), this.localCreateReq({ id, data: { func: func.name, version }, opts, breaksLineage: idChanged }));
  }
  lfc(funcOrName, ...args) {
    const [argu, opts] = splitArgsAndOpts(args, this.options());
    const registered = this.registry.get(funcOrName, opts.version);
    if (typeof funcOrName === "string" && !registered) {
      return new DIE(true, exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(funcOrName, opts.version));
    }
    const idChanged = opts.id !== undefined;
    const id = idChanged ? opts.id : this.seqid();
    this.seq++;
    const func = registered ? registered.func : funcOrName;
    const version = registered ? registered.version : 1;
    return new LFC(id, func, argu, version, opts.retryPolicy ?? (isGeneratorFunction(func) ? new Never : new Exponential), this.localCreateReq({ id, data: { func: func.name, version }, opts, breaksLineage: idChanged }));
  }
  rfi(funcOrName, ...args) {
    const [argu, opts] = splitArgsAndOpts(args, this.options());
    const registered = this.registry.get(funcOrName, opts.version);
    if (typeof funcOrName === "function" && !registered) {
      return new DIE(true, exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(funcOrName.name, opts.version));
    }
    const idChanged = opts.id !== undefined;
    const id = idChanged ? opts.id : this.seqid();
    this.seq++;
    const func = registered ? registered.name : funcOrName;
    const version = registered ? registered.version : 1;
    const data = {
      func,
      args: argu,
      retry: opts.retryPolicy?.encode(),
      version: registered ? registered.version : opts.version || 1
    };
    return new RFI(id, func, version, this.remoteCreateReq({ id, data, opts, breaksLineage: idChanged }));
  }
  rfc(funcOrName, ...args) {
    const [argu, opts] = splitArgsAndOpts(args, this.options());
    const registered = this.registry.get(funcOrName, opts.version);
    if (typeof funcOrName === "function" && !registered) {
      return new DIE(true, exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(funcOrName.name, opts.version));
    }
    const idChanged = opts.id !== undefined;
    const id = idChanged ? opts.id : this.seqid();
    this.seq++;
    const func = registered ? registered.name : funcOrName;
    const version = registered ? registered.version : 1;
    const data = {
      func,
      args: argu,
      retry: opts.retryPolicy?.encode(),
      version: registered ? registered.version : opts.version || 1
    };
    return new RFC(id, func, version, this.remoteCreateReq({ id, data, opts, breaksLineage: idChanged }));
  }
  detached(funcOrName, ...args) {
    const [argu, opts] = splitArgsAndOpts(args, this.options());
    const registered = this.registry.get(funcOrName, opts.version);
    if (typeof funcOrName === "function" && !registered) {
      return new DIE(true, exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(funcOrName.name, opts.version));
    }
    const idChanged = opts.id !== undefined;
    const id = idChanged ? opts.id : this.seqid();
    this.seq++;
    const func = registered ? registered.name : funcOrName;
    const version = registered ? registered.version : 1;
    const data = {
      func,
      args: argu,
      retry: opts.retryPolicy?.encode(),
      version: registered ? registered.version : opts.version || 1
    };
    return new RFI(id, func, version, this.remoteCreateReq({ id, data, opts, maxTimeout: Number.MAX_SAFE_INTEGER, breaksLineage: true }), "detached");
  }
  promise({
    id,
    timeout,
    data,
    tags
  } = {}) {
    const idChanged = id !== undefined;
    id = id ?? this.seqid();
    this.seq++;
    return new RFI(id, "unknown", 1, this.latentCreateOpts({ id, timeout, data, tags, breaksLineage: idChanged }));
  }
  sleep(msOrOpts) {
    let until;
    if (typeof msOrOpts === "number") {
      until = this.clock.now() + msOrOpts;
    } else if (msOrOpts.for != null) {
      until = this.clock.now() + msOrOpts.for;
    } else if (msOrOpts.until != null) {
      until = msOrOpts.until.getTime();
    } else {
      until = 0;
    }
    const id = this.seqid();
    this.seq++;
    return new RFC(id, "sleep", 1, this.sleepCreateOpts({ id, time: until }));
  }
  panic(condition, msg) {
    const src = getCallerInfo();
    return new DIE(condition, exceptions_default.PANIC(src, msg));
  }
  assert(condition, msg) {
    return this.panic(!condition, msg);
  }
  getDependency(name) {
    return this.dependencies.get(name);
  }
  options(opts = {}) {
    return this.optsBuilder.build(opts);
  }
  date = {
    now: () => this.lfc((this.getDependency("resonate:date") ?? Date).now)
  };
  math = {
    random: () => this.lfc((this.getDependency("resonate:math") ?? Math).random)
  };
  localCreateReq({
    id,
    data,
    opts,
    breaksLineage
  }) {
    const timeoutAt = Math.min(this.clock.now() + opts.timeout, this.info.timeout);
    return {
      kind: "promise.create",
      head: { corrId: "", version: "" },
      data: {
        id,
        timeoutAt,
        param: { headers: {}, data },
        tags: {
          "resonate:scope": "local",
          "resonate:branch": this.branchId,
          "resonate:parent": this.id,
          "resonate:origin": breaksLineage ? id : this.originId,
          ...opts.tags
        }
      }
    };
  }
  remoteCreateReq({
    id,
    data,
    opts,
    breaksLineage,
    maxTimeout = this.info.timeout
  }) {
    const timeoutAt = Math.min(this.clock.now() + opts.timeout, maxTimeout);
    return {
      kind: "promise.create",
      head: { corrId: "", version: "" },
      data: {
        id,
        timeoutAt,
        tags: {
          "resonate:scope": "global",
          "resonate:target": opts.target,
          "resonate:branch": id,
          "resonate:parent": this.id,
          "resonate:origin": breaksLineage ? id : this.originId,
          ...opts.tags
        },
        param: { headers: {}, data }
      }
    };
  }
  latentCreateOpts({
    id,
    timeout,
    data,
    tags,
    breaksLineage
  }) {
    const timeoutAt = Math.min(this.clock.now() + (timeout ?? 24 * HOUR), this.info.timeout);
    return {
      kind: "promise.create",
      head: { corrId: "", version: "" },
      data: {
        id,
        timeoutAt,
        param: { data, headers: {} },
        tags: {
          "resonate:scope": "global",
          "resonate:branch": id,
          "resonate:parent": this.id,
          "resonate:origin": breaksLineage ? id : this.originId,
          ...tags
        }
      }
    };
  }
  sleepCreateOpts({ id, time }) {
    const tags = {
      "resonate:scope": "global",
      "resonate:branch": id,
      "resonate:parent": this.id,
      "resonate:origin": this.originId,
      "resonate:timer": "true"
    };
    const timeoutAt = Math.min(time, this.info.timeout);
    return {
      kind: "promise.create",
      head: { corrId: "", version: "" },
      data: {
        id,
        timeoutAt,
        param: { headers: {}, data: "" },
        tags
      }
    };
  }
  seqid() {
    return `${this.id}.${this.seq}`;
  }
}
// src/decorator.ts
class Decorator {
  invokes;
  generator;
  nextState = "internal.nothing";
  constructor(generator) {
    this.generator = generator;
    this.invokes = [];
  }
  next(value) {
    assert(value.type === this.nextState, `Generator called wit type "${value.type}" expected "${this.nextState}"`);
    if (value.type === "internal.promise" && this.invokes.length > 0) {
      const prevInvoke = this.invokes.at(-1);
      if (prevInvoke.kind === "call") {
        this.invokes.pop();
        this.nextState = value.state === "completed" ? "internal.literal" : "over";
        return {
          type: "internal.await",
          id: prevInvoke.id,
          promise: value
        };
      }
    }
    const result = this.safeGeneratorNext(this.toExternal(value));
    if (result.done) {
      this.nextState = "over";
      if (this.invokes.length > 0) {
        const val = this.invokes.pop();
        return {
          type: "internal.await",
          id: val.id,
          promise: {
            type: "internal.promise",
            state: "pending",
            mode: "attached",
            id: val.id
          }
        };
      }
      return {
        type: "internal.return",
        value: this.toLiteral(result.value)
      };
    }
    return this.toInternal(result.value);
  }
  toExternal(value) {
    switch (value.type) {
      case "internal.nothing":
        return { kind: "value", value: undefined };
      case "internal.promise":
        if (value.state === "pending") {
          return { kind: "value", value: new Future(value.id, "pending", undefined, value.mode) };
        }
        this.invokes.pop();
        return { kind: "value", value: new Future(value.id, "completed", value.value.value) };
      case "internal.literal":
        return value.value;
    }
  }
  toInternal(event) {
    if (event instanceof LFI || event instanceof LFC) {
      this.invokes.push({
        kind: event instanceof LFI ? "invoke" : "call",
        id: event.id
      });
      this.nextState = "internal.promise";
      return {
        type: "internal.async.l",
        id: event.id,
        func: event.func,
        args: event.args ?? [],
        version: event.version,
        retryPolicy: event.retryPolicy,
        createReq: event.createReq
      };
    }
    if (event instanceof RFI || event instanceof RFC) {
      if (event.mode === "attached") {
        this.invokes.push({
          kind: event instanceof RFI ? "invoke" : "call",
          id: event.id
        });
      }
      this.nextState = "internal.promise";
      return {
        type: "internal.async.r",
        id: event.id,
        mode: event.mode,
        func: event.func,
        version: event.version,
        createReq: event.createReq
      };
    }
    if (event instanceof DIE) {
      this.nextState = "internal.nothing";
      return {
        type: "internal.die",
        condition: event.condition,
        error: event.error
      };
    }
    if (event instanceof Future) {
      if (event.state === "completed") {
        this.nextState = "internal.literal";
        return {
          type: "internal.await",
          id: event.id,
          promise: {
            type: "internal.promise",
            state: "completed",
            id: event.id,
            value: {
              type: "internal.literal",
              value: event["value"]
            }
          }
        };
      }
      this.invokes = this.invokes.filter(({ id }) => id !== event.id);
      this.nextState = "over";
      return {
        type: "internal.await",
        id: event.id,
        promise: {
          type: "internal.promise",
          state: "pending",
          mode: event["mode"],
          id: event.id
        }
      };
    }
    throw new Error("Unexpected input to extToInt");
  }
  toLiteral(result) {
    return {
      type: "internal.literal",
      value: result
    };
  }
  safeGeneratorNext(value) {
    try {
      let itResult;
      if (value.kind === "error") {
        itResult = this.generator.throw(value.error);
      } else {
        itResult = this.generator.next(value.value);
      }
      if (!itResult.done) {
        return itResult;
      }
      return {
        done: true,
        value: { kind: "value", value: itResult.value }
      };
    } catch (e) {
      return {
        done: true,
        value: { kind: "error", error: e }
      };
    }
  }
}

// src/coroutine.ts
var logged = new Map;

class Coroutine {
  ctx;
  task;
  verbose;
  decorator;
  handler;
  spans;
  depth;
  queueMicrotaskEveryN = 1;
  constructor(ctx, task, verbose, decorator, handler, spans, depth = 1) {
    this.ctx = ctx;
    this.task = task;
    this.verbose = verbose;
    this.decorator = decorator;
    this.handler = handler;
    this.spans = spans;
    this.depth = depth;
    if (!(this.ctx.retryPolicy instanceof Never) && !logged.has(this.ctx.id)) {
      console.warn(`Options. Generator function '${this.ctx.func}' does not support retries. Will ignore.`);
      logged.set(this.ctx.id, true);
    }
    if (typeof process !== "undefined" && process.env.QUEUE_MICROTASK_EVERY_N) {
      this.queueMicrotaskEveryN = Number.parseInt(process.env.QUEUE_MICROTASK_EVERY_N, 10);
    }
  }
  static exec(id, verbose, ctx, func, args, task, handler, spans, callback) {
    const coroutine = new Coroutine(ctx, task, verbose, new Decorator(func(ctx, ...args)), handler, spans);
    coroutine.exec((res) => {
      if (res.kind === "error")
        return callback(res);
      const status = res.value;
      switch (status.type) {
        case "more":
          callback({ kind: "value", value: { type: "suspended", todo: status.todo, spans: status.spans } });
          break;
        case "done":
          callback({ kind: "value", value: status });
          break;
      }
    });
  }
  exec(callback) {
    const local = [];
    const remote = [];
    const spans = [];
    let input = {
      type: "internal.nothing"
    };
    const next = () => {
      while (true) {
        const action = this.decorator.next(input);
        if (action.type === "internal.async.l") {
          let span;
          if (!this.spans.has(action.createReq.data.id)) {
            span = this.ctx.span.startSpan(action.createReq.data.id, this.ctx.clock.now());
            span.setAttribute("type", "run");
            span.setAttribute("func", action.func.name);
            span.setAttribute("version", action.version);
            span.setAttribute("task.id", this.task.id);
            span.setAttribute("task.version", this.task.version);
            this.spans.set(action.createReq.data.id, span);
          } else {
            span = this.spans.get(action.createReq.data.id);
          }
          this.handler.promiseCreate(action.createReq, (res) => {
            if (res.kind === "error") {
              res.error.log(this.verbose);
              span.setStatus(false, String(res.error));
              span.end(this.ctx.clock.now());
              return callback({ kind: "error", error: undefined });
            }
            assertDefined(res);
            span.setStatus(true);
            const ctx = this.ctx.child({
              id: res.value.id,
              func: action.func.name,
              timeout: res.value.timeoutAt,
              version: action.version,
              retryPolicy: action.retryPolicy,
              span
            });
            if (res.value.state === "pending") {
              if (!isGeneratorFunction(action.func)) {
                local.push({
                  id: action.id,
                  ctx,
                  span,
                  func: action.func,
                  args: action.args
                });
                input = {
                  type: "internal.promise",
                  state: "pending",
                  mode: "attached",
                  id: action.id
                };
                next();
                return;
              }
              spans.push(span);
              const coroutine = new Coroutine(ctx, this.task, this.verbose, new Decorator(action.func(ctx, ...action.args)), this.handler, this.spans, this.depth + 1);
              const cb = (res2) => {
                if (res2.kind === "error") {
                  span.end(this.ctx.clock.now());
                  return callback(res2);
                }
                const status = res2.value;
                if (status.type === "more") {
                  local.push(...status.todo.local);
                  remote.push(...status.todo.remote);
                  input = {
                    type: "internal.promise",
                    state: "pending",
                    mode: "attached",
                    id: action.id
                  };
                  next();
                } else {
                  this.handler.promiseSettle({
                    kind: "promise.settle",
                    head: { corrId: "", version: "" },
                    data: {
                      id: action.id,
                      state: status.result.kind === "value" ? "resolved" : "rejected",
                      value: {
                        headers: {},
                        data: status.result.kind === "value" ? status.result.value : status.result.error
                      }
                    }
                  }, (res3) => {
                    span.end(this.ctx.clock.now());
                    spans.splice(spans.indexOf(span));
                    if (res3.kind === "error") {
                      res3.error.log(this.verbose);
                      return callback({ kind: "error", error: undefined });
                    }
                    assert(res3.value.state !== "pending", "promise must be completed");
                    input = {
                      type: "internal.promise",
                      state: "completed",
                      id: action.id,
                      value: {
                        type: "internal.literal",
                        value: res3.value.state === "resolved" ? { kind: "value", value: res3.value.value?.data } : { kind: "error", error: res3.value.value?.data }
                      }
                    };
                    next();
                  }, action.func.name);
                }
              };
              if (this.depth % this.queueMicrotaskEveryN === 0) {
                queueMicrotask(() => coroutine.exec(cb));
              } else {
                coroutine.exec(cb);
              }
            } else {
              span.end(ctx.clock.now());
              input = {
                type: "internal.promise",
                state: "completed",
                id: action.id,
                value: {
                  type: "internal.literal",
                  value: res.value.state === "resolved" ? { kind: "value", value: res.value.value?.data } : { kind: "error", error: res.value.value?.data }
                }
              };
              next();
            }
          }, action.func.name, span.encode());
          return;
        }
        if (action.type === "internal.async.r") {
          let span;
          if (!this.spans.has(action.createReq.data.id)) {
            span = this.ctx.span.startSpan(action.createReq.data.id, this.ctx.clock.now());
            span.setAttribute("type", "rpc");
            span.setAttribute("mode", action.mode);
            span.setAttribute("func", action.func);
            span.setAttribute("version", action.version);
            span.setAttribute("task.id", this.task.id);
            span.setAttribute("task.version", this.task.version);
            this.spans.set(action.createReq.data.id, span);
          } else {
            span = this.spans.get(action.createReq.data.id);
          }
          this.handler.promiseCreate(action.createReq, (res) => {
            if (res.kind === "error") {
              res.error.log(this.verbose);
              span.setStatus(false, String(res.error));
              span.end(this.ctx.clock.now());
              return callback({ kind: "error", error: undefined });
            }
            span.setStatus(true);
            span.end(this.ctx.clock.now());
            assertDefined(res);
            if (res.value.state === "pending") {
              if (action.mode === "attached")
                remote.push({ id: action.id });
              input = {
                type: "internal.promise",
                state: "pending",
                mode: action.mode,
                id: action.id
              };
            } else {
              input = {
                type: "internal.promise",
                state: "completed",
                id: action.id,
                value: {
                  type: "internal.literal",
                  value: res.value.state === "resolved" ? { kind: "value", value: res.value.value?.data } : { kind: "error", error: res.value.value?.data }
                }
              };
            }
            next();
          }, "unknown", span.encode());
          return;
        }
        if (action.type === "internal.die" && !action.condition) {
          input = {
            type: "internal.nothing"
          };
          continue;
        }
        if (action.type === "internal.die" && action.condition) {
          action.error.log(this.verbose);
          return callback({ kind: "error", error: undefined });
        }
        if (action.type === "internal.await" && action.promise.state === "completed") {
          assert(action.promise.value.type === "internal.literal", "promise value must be an 'internal.literal' type");
          assertDefined(action.promise.value);
          input = action.promise.value;
          continue;
        }
        if (action.type === "internal.await" && action.promise.state === "pending") {
          if (action.promise.mode === "detached") {
            remote.push({ id: action.id });
          }
          callback({ kind: "value", value: { type: "more", todo: { local, remote }, spans } });
          return;
        }
        if (action.type === "internal.return") {
          assert(action.value.type === "internal.literal", "promise value must be an 'internal.literal' type");
          assertDefined(action.value);
          assert(spans.length === 0, "all spans should've been closed");
          callback({ kind: "value", value: { type: "done", result: action.value.value } });
          return;
        }
      }
    };
    next();
  }
}

// src/processor/processor.ts
class AsyncProcessor {
  results = new Map;
  pending = new Set;
  completed = new Set;
  waiter = null;
  process(work) {
    for (const item of work) {
      if (this.completed.has(item.id) || this.pending.has(item.id)) {
        continue;
      }
      this.pending.add(item.id);
      this.executeWork(item.id, item.ctx, item.func, item.span, item.verbose).then((result) => this.complete(item.id, result), (error) => this.complete(item.id, { kind: "error", error }));
    }
  }
  getReady(ids, cb) {
    assert(!this.waiter, "AsyncProcessor already has a pending getReady call");
    const ready = this.drain(ids);
    if (ready.length > 0) {
      cb(ready);
      return;
    }
    this.waiter = { ids: new Set(ids), cb };
  }
  complete(id, result) {
    this.pending.delete(id);
    this.completed.add(id);
    this.results.set(id, result);
    this.notifyWaiter(id);
  }
  notifyWaiter(completedId) {
    if (this.waiter === null || !this.waiter.ids.has(completedId)) {
      return;
    }
    const ready = this.drain([...this.waiter.ids]);
    const cb = this.waiter.cb;
    this.waiter = null;
    if (ready.length > 0) {
      cb(ready);
    }
  }
  drain(ids) {
    const ready = [];
    for (const id of ids) {
      const result = this.results.get(id);
      if (result !== undefined) {
        ready.push({ id, result });
        this.results.delete(id);
      }
    }
    return ready;
  }
  async executeWork(id, ctx, func, span, verbose) {
    while (true) {
      const childSpan = span.startSpan(`${id}::${ctx.info.attempt}`, ctx.clock.now());
      childSpan.setAttribute("attempt", ctx.info.attempt);
      try {
        const data = await func();
        childSpan.setStatus(true);
        return { kind: "value", value: data };
      } catch (error) {
        childSpan.setStatus(false, String(error));
        const retryIn = ctx.retryPolicy.next(ctx.info.attempt);
        if (retryIn === null || ctx.clock.now() + retryIn >= ctx.info.timeout) {
          return { kind: "error", error };
        }
        console.warn(`Runtime. Function '${ctx.func}' failed with '${String(error)}' (retrying in ${retryIn / 1000} secs)`);
        if (verbose) {
          console.warn(error);
        }
        ctx.info.attempt++;
        await new Promise((resolve) => setTimeout(resolve, retryIn));
      } finally {
        childSpan.end(ctx.clock.now());
      }
    }
  }
}

// src/computation.ts
class Computation {
  id;
  clock;
  handler;
  retries;
  registry;
  dependencies;
  optsBuilder;
  verbose;
  heartbeat;
  processor;
  span;
  spans;
  seen = new Set;
  processing = false;
  constructor(id, clock, network, handler, retries, registry, heartbeat, dependencies, optsBuilder, verbose, tracer, span, processor) {
    this.id = id;
    this.clock = clock;
    this.handler = handler;
    this.retries = retries;
    this.registry = registry;
    this.heartbeat = heartbeat;
    this.dependencies = dependencies;
    this.optsBuilder = optsBuilder;
    this.verbose = verbose;
    this.processor = processor ?? new AsyncProcessor;
    this.span = span;
    this.spans = new Map;
  }
  executeUntilBlocked(task, done) {
    if (this.processing)
      return done({ kind: "error", error: undefined });
    this.processing = true;
    const doneProcessing = (res) => {
      this.processing = false;
      done(res);
    };
    switch (task.kind) {
      case "claimed":
        this.processAcquired(task, doneProcessing);
        break;
      case "unclaimed":
        assert(false, "All tasks must be claimed at this point");
        break;
    }
  }
  processAcquired({ task, rootPromise }, done) {
    if (!isValidData(rootPromise.param?.data)) {
      return done({ kind: "error", error: undefined });
    }
    const { func, args, retry, version = 1 } = rootPromise.param.data;
    const registered = this.registry.get(func, version);
    if (!registered) {
      exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(func, version).log(this.verbose);
      return done({ kind: "error", error: undefined });
    }
    if (version !== 0)
      assert(version === registered.version, "versions must match");
    assert(func === registered.name, "names must match");
    this.heartbeat.start();
    const retryCtor = retry ? this.retries.get(retry.type) : undefined;
    const retryPolicy = retryCtor ? new retryCtor(retry?.data) : isGeneratorFunction(registered.func) ? new Never : new Exponential;
    if (retry && !retryCtor) {
      console.warn(`Options. Retry policy '${retry.type}' not found. Will ignore.`);
    }
    const ctxConfig = {
      id: this.id,
      oId: rootPromise.tags["resonate:origin"] ?? this.id,
      func: registered.func.name,
      clock: this.clock,
      registry: this.registry,
      dependencies: this.dependencies,
      optsBuilder: this.optsBuilder,
      timeout: rootPromise.timeoutAt,
      version: registered.version,
      retryPolicy,
      span: this.span
    };
    if (isGeneratorFunction(registered.func)) {
      this.processGenerator(ctxConfig, registered.func, args, task, rootPromise, done);
    } else {
      this.processFunction(this.id, new InnerContext(ctxConfig), registered.func, args, (res) => {
        if (res.kind === "error")
          return done({ kind: "error", error: undefined });
        const result = res.value;
        assert(result.kind === "done", "Status must be done after finishing function execution");
        done({
          kind: "value",
          value: {
            kind: "done",
            id: this.id,
            state: result.state === "resolved" ? "resolved" : "rejected",
            value: result.value?.data
          }
        });
      });
    }
  }
  processGenerator(ctxConfig, func, args, task, rootPromise, done) {
    if (rootPromise.state !== "pending") {
      done({
        kind: "value",
        value: {
          kind: "done",
          id: rootPromise.id,
          state: rootPromise.state === "resolved" ? "resolved" : "rejected",
          value: rootPromise.value
        }
      });
    }
    const ctx = new InnerContext(ctxConfig);
    Coroutine.exec(this.id, this.verbose, ctx, func, args, task, this.handler, this.spans, (res) => {
      if (res.kind === "error") {
        return done(res);
      }
      const status = res.value;
      switch (status.type) {
        case "done":
          done({
            kind: "value",
            value: {
              kind: "done",
              id: this.id,
              state: status.result.kind === "value" ? "resolved" : "rejected",
              value: status.result.kind === "value" ? status.result.value : status.result.error
            }
          });
          break;
        case "suspended":
          assert(status.todo.local.length > 0 || status.todo.remote.length > 0, "must be at least one todo");
          if (status.todo.local.length > 0) {
            return this.processLocalTodo(status.todo.local, once(() => this.processGenerator(ctxConfig, func, args, task, rootPromise, done)), (err) => done({ kind: "error", error: undefined }));
          } else if (status.todo.remote.length > 0) {
            done({ kind: "value", value: { kind: "suspended", awaited: status.todo.remote.map((t) => t.id) } });
          }
          break;
      }
    });
  }
  processFunction(id, ctx, func, args, done) {
    this.processor.process([
      {
        id,
        ctx,
        func: async () => await func(ctx, ...args),
        span: ctx.span,
        verbose: this.verbose
      }
    ]);
    this.processor.getReady([id], (results) => {
      assert(results.length === 1, "getReady must return one result");
      const result = results[0];
      const { result: res } = result;
      done({
        kind: "value",
        value: {
          kind: "done",
          id: this.id,
          state: res.kind === "value" ? "resolved" : "rejected",
          value: res.kind === "value" ? res.value : res.error
        }
      });
    });
  }
  processLocalTodo(todo, cb, onErr) {
    const work = todo.map((t) => ({
      id: t.id,
      ctx: t.ctx,
      func: async () => await t.func(t.ctx, ...t.args),
      span: t.ctx.span,
      verbose: this.verbose
    }));
    this.processor.process(work);
    const ids = todo.map((t) => t.id);
    this.processor.getReady(ids, (results) => {
      assert(results.length > 0, "getReady must return results");
      let settledCount = 0;
      for (const result of results) {
        const { id, result: res } = result;
        this.handler.promiseSettle({
          kind: "promise.settle",
          head: { corrId: "", version: "" },
          data: {
            id,
            state: res.kind === "value" ? "resolved" : "rejected",
            value: {
              data: res.kind === "value" ? res.value : res.error,
              headers: {}
            }
          }
        }, (settleRes) => {
          if (settleRes.kind === "error") {
            settleRes.error.log(this.verbose);
            onErr(settleRes.error);
          }
          settledCount++;
          if (settledCount === results.length) {
            cb();
          }
        }, id);
      }
    });
  }
}
function isValidData(data) {
  if (data === null || typeof data !== "object")
    return false;
  const d = data;
  if (typeof d.func !== "string")
    return false;
  if (!Array.isArray(d.args))
    return false;
  if (d.retry !== undefined) {
    if (d.retry === null || typeof d.retry !== "object" || typeof d.retry.type !== "string" || !("data" in d.retry)) {
      return false;
    }
  }
  if (d.version !== undefined && typeof d.version !== "number") {
    return false;
  }
  return true;
}

// src/core.ts
class Core {
  pid;
  ttl;
  clock;
  network;
  handler;
  tracer;
  retries;
  registry;
  heartbeat;
  dependencies;
  optsBuilder;
  verbose;
  computations = new Map;
  constructor({
    pid,
    ttl,
    clock,
    network,
    handler,
    tracer,
    registry,
    heartbeat,
    dependencies,
    optsBuilder,
    verbose,
    messageSource = undefined
  }) {
    this.pid = pid;
    this.ttl = ttl;
    this.clock = clock;
    this.network = network;
    this.handler = handler;
    this.tracer = tracer;
    this.registry = registry;
    this.heartbeat = heartbeat;
    this.dependencies = dependencies;
    this.optsBuilder = optsBuilder;
    this.verbose = verbose;
    this.retries = new Map([
      [Constant.type, Constant],
      [Exponential.type, Exponential],
      [Linear.type, Linear],
      [Never.type, Never]
    ]);
    messageSource?.subscribe("execute", (msg) => {
      this.onMessage(msg, () => {
        return;
      });
    });
  }
  executeUntilBlocked(span, claimed, done) {
    let computation = this.computations.get(claimed.rootPromise.id);
    if (!computation) {
      computation = this.createComputation(claimed.rootPromise.id, span);
      this.computations.set(claimed.rootPromise.id, computation);
    }
    computation.executeUntilBlocked(claimed, (compRes) => {
      if (compRes.kind === "error") {
        return this.releaseTask(claimed.task, () => done(compRes));
      }
      if (compRes.kind === "value") {
        const status = compRes.value;
        if (status.kind === "suspended") {
          return this.suspendTask(claimed, status, (res) => {
            if (res.kind === "error") {
              return done(res);
            }
            if (res.value.continue) {
              return this.executeUntilBlocked(span, claimed, done);
            }
            return done(compRes);
          });
        }
        if (status.kind === "done") {
          return this.fulfillTask(claimed.task, status, () => done(compRes));
        }
      }
    });
  }
  createComputation(id, span) {
    return new Computation(id, this.clock, this.network, this.handler, this.retries, this.registry, this.heartbeat, this.dependencies, this.optsBuilder, this.verbose, this.tracer, span);
  }
  releaseTask(task, callback) {
    this.network.send({
      kind: "task.release",
      head: { corrId: "", version: "" },
      data: { id: task.id, version: task.version }
    }, callback);
  }
  suspendTask(claimed, status, cb) {
    const task = claimed.task;
    this.handler.taskSuspend({
      kind: "task.suspend",
      head: { corrId: "", version: "" },
      data: {
        id: task.id,
        version: task.version,
        actions: status.awaited.map((a) => ({
          kind: "promise.register",
          head: { corrId: "", version: "" },
          data: { awaiter: claimed.rootPromise.id, awaited: a }
        }))
      }
    }, (res) => {
      if (res.kind === "error") {
        res.error.log(this.verbose);
        return cb({ kind: "error", error: undefined });
      } else if (res.kind === "value") {
        return cb(res);
      }
    });
  }
  fulfillTask(task, doneValue, callback) {
    const encoded = this.handler.encodeValue(doneValue.value, doneValue.id);
    if (encoded.kind === "error") {
      encoded.error.log(this.verbose);
      callback();
      return;
    }
    this.network.send({
      kind: "task.fulfill",
      head: { corrId: "", version: "" },
      data: {
        id: task.id,
        version: task.version,
        action: {
          kind: "promise.settle",
          head: { corrId: "", version: "" },
          data: {
            id: doneValue.id,
            state: doneValue.state,
            value: encoded.value
          }
        }
      }
    }, callback);
  }
  onMessage(msg, cb) {
    assert(msg.kind === "execute");
    const task = msg.data.task;
    this.handler.taskAcquire({
      kind: "task.acquire",
      head: { corrId: "", version: "" },
      data: { id: task.id, version: task.version, pid: this.pid, ttl: this.ttl }
    }, (res) => {
      if (res.kind === "error") {
        res.error?.log(this.verbose);
        return cb({ kind: "error", error: undefined });
      } else {
        this.executeUntilBlocked(this.tracer.decode(msg.head), { kind: "claimed", task: res.value.task, rootPromise: res.value.root }, (execRes) => {
          cb(execRes);
        });
      }
    });
  }
}
// src/encoder.ts
class JsonEncoder {
  inf = "__INF__";
  negInf = "__NEG_INF__";
  encode(value) {
    if (value === undefined) {
      return { data: "", headers: {} };
    }
    const json = JSON.stringify(value, (_, v) => {
      if (v === Number.POSITIVE_INFINITY)
        return this.inf;
      if (v === Number.NEGATIVE_INFINITY)
        return this.negInf;
      if (v instanceof AggregateError) {
        return {
          __type: "aggregate_error",
          message: v.message,
          stack: v.stack,
          name: v.name,
          errors: v.errors
        };
      }
      if (v instanceof Error) {
        return {
          __type: "error",
          message: v.message,
          stack: v.stack,
          name: v.name
        };
      }
      return v;
    });
    return {
      headers: {},
      data: base64Encode(json)
    };
  }
  decode(value) {
    if (!value?.data) {
      return;
    }
    return JSON.parse(base64Decode(value.data), (_, v) => {
      if (v === this.inf)
        return Number.POSITIVE_INFINITY;
      if (v === this.negInf)
        return Number.NEGATIVE_INFINITY;
      if (v?.__type === "aggregate_error") {
        return Object.assign(new AggregateError(v.errors, v.message), v);
      }
      if (v?.__type === "error") {
        const err = new Error(v.message || "Unknown error");
        if (v.name)
          err.name = v.name;
        if (v.stack)
          err.stack = v.stack;
        return err;
      }
      return v;
    });
  }
}
// src/encryptor.ts
class NoopEncryptor {
  encrypt(plaintext) {
    return plaintext;
  }
  decrypt(ciphertext) {
    return ciphertext;
  }
}
// src/essential.ts
var exports_essential = {};
__export(exports_essential, {
  isUnprocessable: () => isUnprocessable,
  isSuccess: () => isSuccess,
  isRedirect: () => isRedirect,
  isRateLimited: () => isRateLimited,
  isNotImplemented: () => isNotImplemented,
  isNotFound: () => isNotFound,
  isError: () => isError,
  isConflict: () => isConflict,
  isBadRequest: () => isBadRequest,
  Tasks: () => Tasks,
  Schedules: () => Schedules,
  Registry: () => Registry,
  Promises: () => Promises,
  Options: () => Options,
  LocalNetwork: () => LocalNetwork,
  HttpNetwork: () => HttpNetwork,
  Core: () => Core,
  AsyncProcessor: () => AsyncProcessor
});

// node_modules/eventsource-parser/dist/index.js
class ParseError extends Error {
  constructor(message, options) {
    super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
  }
}
function noop(_arg) {}
function createParser(callbacks) {
  if (typeof callbacks == "function")
    throw new TypeError("`callbacks` must be an object, got a function instead. Did you mean `{onEvent: fn}`?");
  const { onEvent = noop, onError = noop, onRetry = noop, onComment } = callbacks;
  let incompleteLine = "", isFirstChunk = true, id, data = "", eventType = "";
  function feed(newChunk) {
    const chunk = isFirstChunk ? newChunk.replace(/^\xEF\xBB\xBF/, "") : newChunk, [complete, incomplete] = splitLines(`${incompleteLine}${chunk}`);
    for (const line of complete)
      parseLine(line);
    incompleteLine = incomplete, isFirstChunk = false;
  }
  function parseLine(line) {
    if (line === "") {
      dispatchEvent();
      return;
    }
    if (line.startsWith(":")) {
      onComment && onComment(line.slice(line.startsWith(": ") ? 2 : 1));
      return;
    }
    const fieldSeparatorIndex = line.indexOf(":");
    if (fieldSeparatorIndex !== -1) {
      const field = line.slice(0, fieldSeparatorIndex), offset = line[fieldSeparatorIndex + 1] === " " ? 2 : 1, value = line.slice(fieldSeparatorIndex + offset);
      processField(field, value, line);
      return;
    }
    processField(line, "", line);
  }
  function processField(field, value, line) {
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data = `${data}${value}
`;
        break;
      case "id":
        id = value.includes("\x00") ? undefined : value;
        break;
      case "retry":
        /^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
          type: "invalid-retry",
          value,
          line
        }));
        break;
      default:
        onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}…` : field}"`, { type: "unknown-field", field, value, line }));
        break;
    }
  }
  function dispatchEvent() {
    data.length > 0 && onEvent({
      id,
      event: eventType || undefined,
      data: data.endsWith(`
`) ? data.slice(0, -1) : data
    }), id = undefined, data = "", eventType = "";
  }
  function reset(options = {}) {
    incompleteLine && options.consume && parseLine(incompleteLine), isFirstChunk = true, id = undefined, data = "", eventType = "", incompleteLine = "";
  }
  return { feed, reset };
}
function splitLines(chunk) {
  const lines = [];
  let incompleteLine = "", searchIndex = 0;
  for (;searchIndex < chunk.length; ) {
    const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
    let lineEnd = -1;
    if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = Math.min(crIndex, lfIndex) : crIndex !== -1 ? lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1) {
      incompleteLine = chunk.slice(searchIndex);
      break;
    } else {
      const line = chunk.slice(searchIndex, lineEnd);
      lines.push(line), searchIndex = lineEnd + 1, chunk[searchIndex - 1] === "\r" && chunk[searchIndex] === `
` && searchIndex++;
    }
  }
  return [lines, incompleteLine];
}

// node_modules/eventsource/dist/index.js
class ErrorEvent extends Event {
  constructor(type, errorEventInitDict) {
    var _a, _b;
    super(type), this.code = (_a = errorEventInitDict == null ? undefined : errorEventInitDict.code) != null ? _a : undefined, this.message = (_b = errorEventInitDict == null ? undefined : errorEventInitDict.message) != null ? _b : undefined;
  }
  [Symbol.for("nodejs.util.inspect.custom")](_depth, options, inspect) {
    return inspect(inspectableError(this), options);
  }
  [Symbol.for("Deno.customInspect")](inspect, options) {
    return inspect(inspectableError(this), options);
  }
}
function syntaxError(message) {
  const DomException = globalThis.DOMException;
  return typeof DomException == "function" ? new DomException(message, "SyntaxError") : new SyntaxError(message);
}
function flattenError(err) {
  return err instanceof Error ? "errors" in err && Array.isArray(err.errors) ? err.errors.map(flattenError).join(", ") : ("cause" in err) && err.cause instanceof Error ? `${err}: ${flattenError(err.cause)}` : err.message : `${err}`;
}
function inspectableError(err) {
  return {
    type: err.type,
    message: err.message,
    code: err.code,
    defaultPrevented: err.defaultPrevented,
    cancelable: err.cancelable,
    timeStamp: err.timeStamp
  };
}
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var _readyState;
var _url;
var _redirectUrl;
var _withCredentials;
var _fetch;
var _reconnectInterval;
var _reconnectTimer;
var _lastEventId;
var _controller;
var _parser;
var _onError;
var _onMessage;
var _onOpen;
var _EventSource_instances;
var connect_fn;
var _onFetchResponse;
var _onFetchError;
var getRequestOptions_fn;
var _onEvent;
var _onRetryChange;
var failConnection_fn;
var scheduleReconnect_fn;
var _reconnect;

class EventSource extends EventTarget {
  constructor(url, eventSourceInitDict) {
    var _a, _b;
    super(), __privateAdd(this, _EventSource_instances), this.CONNECTING = 0, this.OPEN = 1, this.CLOSED = 2, __privateAdd(this, _readyState), __privateAdd(this, _url), __privateAdd(this, _redirectUrl), __privateAdd(this, _withCredentials), __privateAdd(this, _fetch), __privateAdd(this, _reconnectInterval), __privateAdd(this, _reconnectTimer), __privateAdd(this, _lastEventId, null), __privateAdd(this, _controller), __privateAdd(this, _parser), __privateAdd(this, _onError, null), __privateAdd(this, _onMessage, null), __privateAdd(this, _onOpen, null), __privateAdd(this, _onFetchResponse, async (response) => {
      var _a2;
      __privateGet(this, _parser).reset();
      const { body, redirected, status, headers } = response;
      if (status === 204) {
        __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, "Server sent HTTP 204, not reconnecting", 204), this.close();
        return;
      }
      if (redirected ? __privateSet(this, _redirectUrl, new URL(response.url)) : __privateSet(this, _redirectUrl, undefined), status !== 200) {
        __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, `Non-200 status code (${status})`, status);
        return;
      }
      if (!(headers.get("content-type") || "").startsWith("text/event-stream")) {
        __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, 'Invalid content type, expected "text/event-stream"', status);
        return;
      }
      if (__privateGet(this, _readyState) === this.CLOSED)
        return;
      __privateSet(this, _readyState, this.OPEN);
      const openEvent = new Event("open");
      if ((_a2 = __privateGet(this, _onOpen)) == null || _a2.call(this, openEvent), this.dispatchEvent(openEvent), typeof body != "object" || !body || !("getReader" in body)) {
        __privateMethod(this, _EventSource_instances, failConnection_fn).call(this, "Invalid response body, expected a web ReadableStream", status), this.close();
        return;
      }
      const decoder = new TextDecoder, reader = body.getReader();
      let open = true;
      do {
        const { done, value } = await reader.read();
        value && __privateGet(this, _parser).feed(decoder.decode(value, { stream: !done })), done && (open = false, __privateGet(this, _parser).reset(), __privateMethod(this, _EventSource_instances, scheduleReconnect_fn).call(this));
      } while (open);
    }), __privateAdd(this, _onFetchError, (err) => {
      __privateSet(this, _controller, undefined), !(err.name === "AbortError" || err.type === "aborted") && __privateMethod(this, _EventSource_instances, scheduleReconnect_fn).call(this, flattenError(err));
    }), __privateAdd(this, _onEvent, (event) => {
      typeof event.id == "string" && __privateSet(this, _lastEventId, event.id);
      const messageEvent = new MessageEvent(event.event || "message", {
        data: event.data,
        origin: __privateGet(this, _redirectUrl) ? __privateGet(this, _redirectUrl).origin : __privateGet(this, _url).origin,
        lastEventId: event.id || ""
      });
      __privateGet(this, _onMessage) && (!event.event || event.event === "message") && __privateGet(this, _onMessage).call(this, messageEvent), this.dispatchEvent(messageEvent);
    }), __privateAdd(this, _onRetryChange, (value) => {
      __privateSet(this, _reconnectInterval, value);
    }), __privateAdd(this, _reconnect, () => {
      __privateSet(this, _reconnectTimer, undefined), __privateGet(this, _readyState) === this.CONNECTING && __privateMethod(this, _EventSource_instances, connect_fn).call(this);
    });
    try {
      if (url instanceof URL)
        __privateSet(this, _url, url);
      else if (typeof url == "string")
        __privateSet(this, _url, new URL(url, getBaseURL()));
      else
        throw new Error("Invalid URL");
    } catch {
      throw syntaxError("An invalid or illegal string was specified");
    }
    __privateSet(this, _parser, createParser({
      onEvent: __privateGet(this, _onEvent),
      onRetry: __privateGet(this, _onRetryChange)
    })), __privateSet(this, _readyState, this.CONNECTING), __privateSet(this, _reconnectInterval, 3000), __privateSet(this, _fetch, (_a = eventSourceInitDict == null ? undefined : eventSourceInitDict.fetch) != null ? _a : globalThis.fetch), __privateSet(this, _withCredentials, (_b = eventSourceInitDict == null ? undefined : eventSourceInitDict.withCredentials) != null ? _b : false), __privateMethod(this, _EventSource_instances, connect_fn).call(this);
  }
  get readyState() {
    return __privateGet(this, _readyState);
  }
  get url() {
    return __privateGet(this, _url).href;
  }
  get withCredentials() {
    return __privateGet(this, _withCredentials);
  }
  get onerror() {
    return __privateGet(this, _onError);
  }
  set onerror(value) {
    __privateSet(this, _onError, value);
  }
  get onmessage() {
    return __privateGet(this, _onMessage);
  }
  set onmessage(value) {
    __privateSet(this, _onMessage, value);
  }
  get onopen() {
    return __privateGet(this, _onOpen);
  }
  set onopen(value) {
    __privateSet(this, _onOpen, value);
  }
  addEventListener(type, listener, options) {
    const listen = listener;
    super.addEventListener(type, listen, options);
  }
  removeEventListener(type, listener, options) {
    const listen = listener;
    super.removeEventListener(type, listen, options);
  }
  close() {
    __privateGet(this, _reconnectTimer) && clearTimeout(__privateGet(this, _reconnectTimer)), __privateGet(this, _readyState) !== this.CLOSED && (__privateGet(this, _controller) && __privateGet(this, _controller).abort(), __privateSet(this, _readyState, this.CLOSED), __privateSet(this, _controller, undefined));
  }
}
_readyState = /* @__PURE__ */ new WeakMap, _url = /* @__PURE__ */ new WeakMap, _redirectUrl = /* @__PURE__ */ new WeakMap, _withCredentials = /* @__PURE__ */ new WeakMap, _fetch = /* @__PURE__ */ new WeakMap, _reconnectInterval = /* @__PURE__ */ new WeakMap, _reconnectTimer = /* @__PURE__ */ new WeakMap, _lastEventId = /* @__PURE__ */ new WeakMap, _controller = /* @__PURE__ */ new WeakMap, _parser = /* @__PURE__ */ new WeakMap, _onError = /* @__PURE__ */ new WeakMap, _onMessage = /* @__PURE__ */ new WeakMap, _onOpen = /* @__PURE__ */ new WeakMap, _EventSource_instances = /* @__PURE__ */ new WeakSet, connect_fn = function() {
  __privateSet(this, _readyState, this.CONNECTING), __privateSet(this, _controller, new AbortController), __privateGet(this, _fetch)(__privateGet(this, _url), __privateMethod(this, _EventSource_instances, getRequestOptions_fn).call(this)).then(__privateGet(this, _onFetchResponse)).catch(__privateGet(this, _onFetchError));
}, _onFetchResponse = /* @__PURE__ */ new WeakMap, _onFetchError = /* @__PURE__ */ new WeakMap, getRequestOptions_fn = function() {
  var _a;
  const init = {
    mode: "cors",
    redirect: "follow",
    headers: { Accept: "text/event-stream", ...__privateGet(this, _lastEventId) ? { "Last-Event-ID": __privateGet(this, _lastEventId) } : undefined },
    cache: "no-store",
    signal: (_a = __privateGet(this, _controller)) == null ? undefined : _a.signal
  };
  return "window" in globalThis && (init.credentials = this.withCredentials ? "include" : "same-origin"), init;
}, _onEvent = /* @__PURE__ */ new WeakMap, _onRetryChange = /* @__PURE__ */ new WeakMap, failConnection_fn = function(message, code) {
  var _a;
  __privateGet(this, _readyState) !== this.CLOSED && __privateSet(this, _readyState, this.CLOSED);
  const errorEvent = new ErrorEvent("error", { code, message });
  (_a = __privateGet(this, _onError)) == null || _a.call(this, errorEvent), this.dispatchEvent(errorEvent);
}, scheduleReconnect_fn = function(message, code) {
  var _a;
  if (__privateGet(this, _readyState) === this.CLOSED)
    return;
  __privateSet(this, _readyState, this.CONNECTING);
  const errorEvent = new ErrorEvent("error", { code, message });
  (_a = __privateGet(this, _onError)) == null || _a.call(this, errorEvent), this.dispatchEvent(errorEvent), __privateSet(this, _reconnectTimer, setTimeout(__privateGet(this, _reconnect), __privateGet(this, _reconnectInterval)));
}, _reconnect = /* @__PURE__ */ new WeakMap, EventSource.CONNECTING = 0, EventSource.OPEN = 1, EventSource.CLOSED = 2;
function getBaseURL() {
  const doc = "document" in globalThis ? globalThis.document : undefined;
  return doc && typeof doc == "object" && "baseURI" in doc && typeof doc.baseURI == "string" ? doc.baseURI : undefined;
}

// src/network/http.ts
class HttpNetwork {
  url;
  timeout;
  headers;
  verbose;
  constructor({
    url = "http://localhost:8001",
    timeout = 1e4 * SEC,
    headers = {},
    auth = undefined,
    token = undefined,
    verbose = true
  }) {
    this.url = url;
    this.timeout = timeout;
    this.verbose = verbose;
    this.headers = { "Content-Type": "application/json", ...headers };
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    } else if (auth) {
      this.headers.Authorization = `Basic ${base64Encode(`${auth.username}:${auth.password}`)}`;
    }
  }
  start() {}
  stop() {}
  send(req, callback, headers = {}, retryForever = false) {
    const retryPolicy = retryForever ? { retries: Number.MAX_SAFE_INTEGER, delay: 1e4 } : { retries: 0 };
    this.doSend(req, headers, retryPolicy).then((res) => {
      assert(res.kind === req.kind, "res kind must match req kind");
      callback(res);
    }, (err) => {
      console.error(err);
      assert(false, "something went wrong");
    });
  }
  async doSend(req, headers, { retries = 0, delay = 1000 } = {}) {
    for (let attempt = 0;attempt <= retries; attempt++) {
      const controller = new AbortController;
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        if (this.verbose) {
          console.log(`[HttpNetwork] Sending ${req.kind}:`, JSON.stringify(req, null, 2));
        }
        const response = await fetch(`${this.url}/api`, {
          method: "POST",
          headers: { ...this.headers, ...headers },
          body: JSON.stringify(req),
          signal: controller.signal
        });
        const body = await response.json();
        if (this.verbose) {
          console.log(`[HttpNetwork] Received ${response.status}:`, `for request:`, req, `response.ok:${response.ok}`, body);
        }
        if (!response.ok) {
          const err = await response.json().then((r) => r.error).catch(() => {
            return;
          });
          throw exceptions_default.SERVER_ERROR(err ? err.message : response.statusText, response.status >= 500 && response.status < 600, err);
        }
        return body;
      } catch (err) {
        console.log(err);
        if (err instanceof ResonateError && !err.retriable) {
          throw err;
        }
        if (attempt >= retries) {
          if (err instanceof ResonateError) {
            throw err;
          }
          throw exceptions_default.SERVER_ERROR(String(err));
        }
        console.warn(`Networking. Cannot connect to [${this.url}]. Retrying in ${delay / 1000}s.`);
        if (this.verbose) {
          console.warn(err);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw new Error("Fetch error");
  }
}

class PollMessageSource {
  pid;
  group;
  unicast;
  anycast;
  url;
  headers;
  eventSource;
  subscriptions = { execute: [], notify: [] };
  constructor({
    url = "http://localhost:8001",
    pid = crypto.randomUUID().replace(/-/g, ""),
    group = "default",
    auth = undefined,
    token = undefined
  }) {
    this.url = url;
    this.pid = pid;
    this.group = group;
    this.unicast = `poll://uni@${group}/${pid}`;
    this.anycast = `poll://any@${group}/${pid}`;
    this.headers = {};
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    } else if (auth) {
      this.headers.Authorization = `Basic ${base64Encode(`${auth.username}:${auth.password}`)}`;
    }
    this.eventSource = this.connect();
  }
  connect() {
    const url = new URL(`/poll/${encodeURIComponent(this.group)}/${encodeURIComponent(this.pid)}`, `${this.url}`);
    this.eventSource = new EventSource(url, {
      fetch: (url2, init) => fetch(url2, {
        ...init,
        headers: {
          ...init.headers,
          ...this.headers
        }
      })
    });
    this.eventSource.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.warn("Networking. Received invalid message. Will continue.");
        return;
      }
      this.recv(msg);
    });
    this.eventSource.addEventListener("error", () => {
      this.eventSource.close();
      console.warn(`Networking. Cannot connect to [${this.url}/poll]. Retrying in 5s.`);
      setTimeout(() => this.connect(), 5000);
    });
    return this.eventSource;
  }
  recv(msg) {
    for (const callback of this.subscriptions[msg.kind]) {
      callback(msg);
    }
  }
  start() {}
  stop() {
    this.eventSource.close();
  }
  subscribe(type, callback) {
    this.subscriptions[type].push(callback);
  }
  match(target) {
    return `poll://any@${target}`;
  }
}
// src/network/local.ts
var PENDING_RETRY_TTL = 30000;

class Server {
  promises = new Map;
  tasks = new Map;
  pTimeouts = [];
  tTimeouts = [];
  outgoing = new Map;
  messages = [];
  changes = [];
  branches = [];
  apply(now, req) {
    this.messages = [];
    this.changes = [];
    this.branches = [];
    const timeoutActions = this.collectTimeoutActions(now);
    for (const action of timeoutActions) {
      if (action.kind === "task.retry") {
        this.retryTask(now, action.data);
      } else if (action.kind === "task.release") {
        this.releaseTask(now, action.data, true);
      } else {
        this.settlePromise(now, action.data);
      }
    }
    if (!req) {
      return {
        response: {
          kind: "tick",
          head: { status: 200 },
          data: {
            promiseTimeouts: this.pTimeouts.length,
            taskPendingRetries: this.tTimeouts.filter((t) => t.type === 0).length,
            taskLeaseTimeouts: this.tTimeouts.filter((t) => t.type === 1).length
          }
        },
        messages: this.messages,
        changes: this.changes,
        branches: this.branches
      };
    }
    const response = this.dispatch(req, now);
    return {
      response,
      messages: this.messages,
      changes: this.changes,
      branches: this.branches
    };
  }
  collectTimeoutActions(now) {
    const actions = [];
    for (const pt of this.pTimeouts) {
      if (now >= pt.timeout) {
        const promise = this.promises.get(pt.id);
        if (promise && promise.state === "pending") {
          actions.push({ kind: "promise.settle", data: { id: pt.id, state: "rejected_timedout" } });
        }
      }
    }
    for (const tt of this.tTimeouts) {
      if (tt.type === 0 && now >= tt.timeout) {
        const task = this.tasks.get(tt.id);
        if (task && task.state === "pending") {
          actions.push({ kind: "task.retry", data: { id: tt.id, version: task.version } });
        }
      }
    }
    for (const tt of this.tTimeouts) {
      if (tt.type === 1 && now >= tt.timeout) {
        const task = this.tasks.get(tt.id);
        if (task && task.state === "acquired") {
          actions.push({ kind: "task.release", data: { id: tt.id, version: task.version } });
        }
      }
    }
    return actions;
  }
  retryTask(now, data) {
    const task = this.tasks.get(data.id);
    if (!task || task.state !== "pending" || task.version !== data.version) {
      return;
    }
    const tt = this.tTimeouts.find((t) => t.id === data.id && t.type === 0);
    if (tt) {
      tt.timeout = now + PENDING_RETRY_TTL;
    }
    const promise = this.promises.get(data.id);
    if (promise) {
      const address = promise.tags["resonate:target"];
      if (address) {
        const msg = { id: data.id, version: task.version, address };
        this.messages.push(msg);
        this.outgoing.set(data.id, msg);
      }
    }
    this.branches.push("timeout.task.pending_retry");
  }
  dispatch(req, now) {
    switch (req.kind) {
      case "promise.get":
        return this.getPromise(now, req.data);
      case "promise.create":
        return this.createPromise(now, req.data);
      case "promise.settle":
        return this.settlePromise(now, req.data);
      case "promise.register":
        return this.registerCallback(now, req.data);
      case "task.get":
        return this.getTask(now, req.data);
      case "task.acquire":
        return this.acquireTask(now, req.data);
      case "task.release":
        return this.releaseTask(now, req.data);
      case "task.fulfill":
        return this.fulfillTask(now, req.data);
      case "task.suspend":
        return this.suspendTask(now, req.data);
      case "task.fence":
        return this.fenceTask(now, req.data);
      case "task.heartbeat":
        return this.heartbeatTask(now, req.data);
      case "task.create":
        return this.createTask(now, req.data);
      case "promise.subscribe":
        return this.perror(501, "Not implemented", []);
      case "schedule.get":
      case "schedule.create":
      case "schedule.delete":
        return this.perror(501, "Not implemented", []);
      default:
        return this.perror(400, "Operation not supported", []);
    }
  }
  getPromise(_now, data) {
    const promise = this.promises.get(data.id);
    if (!promise) {
      return this.perror(404, "Promise not found", ["promise.get.not_found"]);
    }
    return this.pvalue("promise.get", 200, { promise: this.toPromiseRecord(promise) }, [], ["promise.get.found"]);
  }
  createPromise(now, data) {
    const existing = this.promises.get(data.id);
    if (existing) {
      return this.pvalue("promise.create", 200, { promise: this.toPromiseRecord(existing) }, [], ["promise.create.exists"]);
    }
    const promise = {
      id: data.id,
      state: "pending",
      param: data.param ?? {},
      value: {},
      tags: data.tags ?? {},
      createdAt: now,
      settledAt: null,
      timeoutAt: data.timeoutAt,
      awaiters: []
    };
    this.promises.set(data.id, promise);
    this.pTimeouts.push({ id: data.id, timeout: data.timeoutAt });
    const invokeAddress = data.tags?.["resonate:target"];
    if (invokeAddress) {
      const task = { id: data.id, state: "pending", version: 0 };
      this.tasks.set(data.id, task);
      this.tTimeouts.push({ id: data.id, type: 0, timeout: now + PENDING_RETRY_TTL });
      const msg = { id: data.id, version: 0, address: invokeAddress };
      this.messages.push(msg);
      this.outgoing.set(data.id, msg);
      return this.pvalue("promise.create", 200, { promise: this.toPromiseRecord(promise) }, [{ kind: "DidCreate", id: data.id }], ["promise.create.created_with_task"]);
    }
    return this.pvalue("promise.create", 200, { promise: this.toPromiseRecord(promise) }, [{ kind: "DidCreate", id: data.id }], ["promise.create.created"]);
  }
  settlePromise(now, data) {
    const promise = this.promises.get(data.id);
    if (!promise) {
      return this.perror(404, "Promise not found", ["promise.settle.not_found"]);
    }
    if (promise.state !== "pending") {
      return this.pvalue("promise.settle", 200, { promise: this.toPromiseRecord(promise) }, [], ["promise.settle.already_settled"]);
    }
    promise.state = data.state;
    promise.value = data.value ?? {};
    promise.settledAt = now;
    const ptIdx = this.pTimeouts.findIndex((pt) => pt.id === data.id);
    if (ptIdx !== -1) {
      this.pTimeouts.splice(ptIdx, 1);
    }
    this.enqueueSettle(data.id);
    this.resumeAwaiters(data.id, now);
    const branch = data.state === "rejected_timedout" ? "timeout.promise" : "promise.settle.settled";
    return this.pvalue("promise.settle", 200, { promise: this.toPromiseRecord(promise) }, [{ kind: "DidSettle", id: data.id }], [branch]);
  }
  registerCallback(_now, data) {
    const awaitedPromise = this.promises.get(data.awaited);
    if (!awaitedPromise) {
      return this.perror(404, "Awaited promise not found", ["promise.register.not_found"]);
    }
    const awaiterPromise = this.promises.get(data.awaiter);
    if (!awaiterPromise) {
      return this.perror(404, "Promise not found", ["promise.register.awaiter_not_found"]);
    }
    if (awaitedPromise.state !== "pending") {
      return this.pvalue("promise.register", 300, { promise: this.toPromiseRecord(awaitedPromise) }, [], ["promise.register.awaited_settled"]);
    }
    let branch;
    if (awaiterPromise.state === "pending" && awaiterPromise.tags["resonate:target"] != null && !awaitedPromise.awaiters.includes(data.awaiter)) {
      awaitedPromise.awaiters = [...awaitedPromise.awaiters, data.awaiter].sort();
      branch = "promise.register.created";
    } else if (awaitedPromise.awaiters.includes(data.awaiter)) {
      branch = "promise.register.exists";
    } else {
      branch = "promise.register.awaiter_settled";
    }
    return this.pvalue("promise.register", 200, { promise: this.toPromiseRecord(awaitedPromise) }, [], [branch]);
  }
  getTask(_now, data) {
    const task = this.tasks.get(data.id);
    if (!task) {
      return this.perror(404, "Task not found", ["task.get.not_found"]);
    }
    return this.pvalue("task.get", 200, { task: this.toTaskRecord(task) }, [], ["task.get.found"]);
  }
  acquireTask(now, data) {
    const task = this.tasks.get(data.id);
    if (!task) {
      return this.perror(404, "Task not found", ["task.acquire.not_found"]);
    }
    if (task.state !== "pending") {
      return this.perror(409, "Task not in pending state", ["task.acquire.not_pending"]);
    }
    if (task.version !== data.version) {
      return this.perror(409, "Version mismatch", ["task.acquire.version_mismatch"]);
    }
    const promise = this.getPromiseOrThrow(data.id);
    task.state = "acquired";
    task.pid = data.pid;
    task.ttl = data.ttl;
    const { timeout: tt } = this.getTTimeoutOrThrow(data.id);
    tt.type = 1;
    tt.timeout = now + data.ttl;
    return this.pvalue("task.acquire", 200, { promise: this.toPromiseRecord(promise), preload: [] }, [], ["task.acquire.invoke"]);
  }
  releaseTask(now, data, isTimeout = false) {
    const task = this.tasks.get(data.id);
    if (!task) {
      return this.perror(404, "Task not found", ["task.release.not_found"]);
    }
    if (task.state !== "acquired") {
      return this.perror(409, "Task not acquired", ["task.release.not_acquired"]);
    }
    if (task.version !== data.version) {
      return this.perror(409, "Version mismatch", ["task.release.version_mismatch"]);
    }
    task.state = "pending";
    task.version++;
    task.pid = undefined;
    const { timeout: tt } = this.getTTimeoutOrThrow(data.id);
    tt.type = 0;
    tt.timeout = now + PENDING_RETRY_TTL;
    const promise = this.getPromiseOrThrow(data.id);
    const address = promise.tags["resonate:target"];
    if (address) {
      const msg = { id: data.id, version: task.version, address };
      this.messages.push(msg);
      this.outgoing.set(data.id, msg);
    }
    const branch = isTimeout ? "timeout.task.lease" : "task.release.released";
    return this.pvalue("task.release", 200, {}, [], [branch]);
  }
  fulfillTask(now, data) {
    const task = this.tasks.get(data.id);
    if (!task) {
      return this.perror(404, "Task not found", ["task.fulfill.not_found"]);
    }
    if (task.state !== "acquired") {
      return this.perror(409, "Task not acquired", ["task.fulfill.not_acquired"]);
    }
    if (task.version !== data.version) {
      return this.perror(409, "Version mismatch", ["task.fulfill.version_mismatch"]);
    }
    const settle = data.action.data;
    if (settle.id !== data.id) {
      return this.perror(400, "Promise ID must match task ID", ["task.fulfill.promise_id_mismatch"]);
    }
    const promise = this.promises.get(settle.id);
    if (!promise) {
      return this.perror(404, "Promise not found", ["task.fulfill.not_found"]);
    }
    if (promise.state !== "pending") {
      this.enqueueSettle(data.id);
      return this.pvalue("task.fulfill", 200, { promise: this.toPromiseRecord(promise) }, [], ["task.fulfill.already_settled"]);
    }
    promise.state = settle.state;
    promise.value = settle.value ?? {};
    promise.settledAt = now;
    const ptIdx = this.pTimeouts.findIndex((pt) => pt.id === settle.id);
    if (ptIdx !== -1) {
      this.pTimeouts.splice(ptIdx, 1);
    }
    this.enqueueSettle(data.id);
    this.resumeAwaiters(settle.id, now);
    return this.pvalue("task.fulfill", 200, { promise: this.toPromiseRecord(promise) }, [{ kind: "DidSettle", id: settle.id }], ["task.fulfill.settled"]);
  }
  suspendTask(now, data) {
    const task = this.tasks.get(data.id);
    if (!task) {
      return this.perror(404, "Task not found", ["task.suspend.not_found"]);
    }
    if (task.state !== "acquired") {
      return this.perror(409, "Task not acquired", ["task.suspend.not_acquired"]);
    }
    if (task.version !== data.version) {
      return this.perror(409, "Version mismatch", ["task.suspend.version_mismatch"]);
    }
    let hasImmediateResume = false;
    let hasValidAwaiting = false;
    for (const action of data.actions) {
      const result = this.registerCallback(now, action.data);
      if (result.kind === "error") {
        continue;
      }
      if (result.head.status === 300) {
        hasImmediateResume = true;
      } else {
        const awaitedPromise = this.promises.get(action.data.awaited);
        if (awaitedPromise && awaitedPromise.state === "pending" && awaitedPromise.awaiters.includes(action.data.awaiter)) {
          hasValidAwaiting = true;
        }
      }
    }
    if (hasImmediateResume) {
      return this.pvalue("task.suspend", 300, {}, [], ["task.suspend.immediate_resume"]);
    }
    if (hasValidAwaiting) {
      task.state = "suspended";
      task.pid = undefined;
      const { index: ttIdx } = this.getTTimeoutOrThrow(data.id);
      this.tTimeouts.splice(ttIdx, 1);
      return this.pvalue("task.suspend", 200, {}, [], ["task.suspend.suspended"]);
    }
    return this.pvalue("task.suspend", 200, {}, [], []);
  }
  fenceTask(now, data) {
    const task = this.tasks.get(data.id);
    if (!task) {
      return this.perror(404, "Task not found", ["task.fence.not_found"]);
    }
    if (task.state !== "acquired") {
      return this.perror(409, "Fence check failed", ["task.fence.not_owned"]);
    }
    if (task.version !== data.version) {
      return this.perror(409, "Fence check failed", ["task.fence.not_owned"]);
    }
    const { timeout: tt } = this.getTTimeoutOrThrow(data.id);
    const ttl = task.ttl ?? 30000;
    tt.timeout = now + ttl;
    const action = data.action;
    if (action.kind === "promise.create") {
      return this.fenceCreate(now, action.data);
    } else {
      return this.fenceSettle(now, action.data);
    }
  }
  fenceCreate(now, data) {
    const existing = this.promises.get(data.id);
    if (existing) {
      return this.pvalue("task.fence", 200, {
        action: {
          kind: "promise.create",
          head: { corrId: "", status: 200, version: "" },
          data: { promise: this.toPromiseRecord(existing) }
        }
      }, [], ["task.fence.create.exists"]);
    }
    const promise = {
      id: data.id,
      state: "pending",
      param: data.param ?? {},
      value: {},
      tags: data.tags ?? {},
      createdAt: now,
      settledAt: null,
      timeoutAt: data.timeoutAt,
      awaiters: []
    };
    this.promises.set(data.id, promise);
    this.pTimeouts.push({ id: data.id, timeout: data.timeoutAt });
    const invokeAddress = data.tags?.["resonate:target"];
    if (invokeAddress) {
      const task = { id: data.id, state: "pending", version: 0 };
      this.tasks.set(data.id, task);
      this.tTimeouts.push({ id: data.id, type: 0, timeout: now + PENDING_RETRY_TTL });
      const msg = { id: data.id, version: 0, address: invokeAddress };
      this.messages.push(msg);
      this.outgoing.set(data.id, msg);
      return this.pvalue("task.fence", 200, {
        action: {
          kind: "promise.create",
          head: { corrId: "", status: 200, version: "" },
          data: { promise: this.toPromiseRecord(promise) }
        }
      }, [{ kind: "DidCreate", id: data.id }], ["task.fence.create.created_with_task"]);
    }
    return this.pvalue("task.fence", 200, {
      action: {
        kind: "promise.create",
        head: { corrId: "", status: 200, version: "" },
        data: { promise: this.toPromiseRecord(promise) }
      }
    }, [{ kind: "DidCreate", id: data.id }], ["task.fence.create.created"]);
  }
  fenceSettle(now, data) {
    const promise = this.promises.get(data.id);
    if (!promise) {
      return this.perror(404, "Promise not found", ["task.fence.settle.not_found"]);
    }
    if (promise.state !== "pending") {
      return this.pvalue("task.fence", 200, {
        action: {
          kind: "promise.settle",
          head: { corrId: "", status: 200, version: "" },
          data: { promise: this.toPromiseRecord(promise) }
        }
      }, [], ["task.fence.settle.already_settled"]);
    }
    promise.state = data.state;
    promise.value = data.value ?? {};
    promise.settledAt = now;
    const ptIdx = this.pTimeouts.findIndex((pt) => pt.id === data.id);
    if (ptIdx !== -1) {
      this.pTimeouts.splice(ptIdx, 1);
    }
    this.enqueueSettle(data.id);
    this.resumeAwaiters(data.id, now);
    return this.pvalue("task.fence", 200, {
      action: {
        kind: "promise.settle",
        head: { corrId: "", status: 200, version: "" },
        data: { promise: this.toPromiseRecord(promise) }
      }
    }, [{ kind: "DidSettle", id: data.id }], ["task.fence.settle.settled"]);
  }
  createTask(now, data) {
    const existingPromise = this.promises.get(data.action.data.id);
    const existingTask = this.tasks.get(data.action.data.id);
    if (existingPromise && !existingTask) {
      return this.perror(409, "Promise exists without associated task", ["task.create.promise_without_task"]);
    }
    if (existingTask && existingTask.state === "acquired" && existingTask.pid !== data.pid) {
      return this.perror(409, "Task is already acquired by another process", ["task.create.task_already_acquired"]);
    }
    if (existingPromise && existingTask) {
      return this.pvalue("task.create", 200, { task: this.toTaskRecord(existingTask), promise: this.toPromiseRecord(existingPromise) }, [], ["task.create.exists"]);
    }
    const promise = {
      id: data.action.data.id,
      state: "pending",
      param: data.action.data.param ?? {},
      value: {},
      tags: data.action.data.tags ?? {},
      createdAt: now,
      settledAt: null,
      timeoutAt: data.action.data.timeoutAt,
      awaiters: []
    };
    this.promises.set(data.action.data.id, promise);
    this.pTimeouts.push({ id: data.action.data.id, timeout: data.action.data.timeoutAt });
    const task = {
      id: data.action.data.id,
      state: "acquired",
      version: 0,
      pid: data.pid,
      ttl: data.ttl
    };
    this.tasks.set(data.action.data.id, task);
    this.tTimeouts.push({ id: data.action.data.id, type: 1, timeout: now + data.ttl });
    return this.pvalue("task.create", 200, { task: this.toTaskRecord(task), promise: this.toPromiseRecord(promise) }, [{ kind: "DidCreate", id: data.action.data.id }], ["task.create.created"]);
  }
  heartbeatTask(_now, data) {
    for (const ref of data.tasks) {
      const task = this.tasks.get(ref.id);
      if (!task || task.state !== "acquired" || task.version !== ref.version) {
        continue;
      }
      const ttl = task.ttl ?? 30000;
      const ttIdx = this.tTimeouts.findIndex((tt) => tt.id === ref.id && tt.type === 1);
      if (ttIdx !== -1) {
        this.tTimeouts[ttIdx].timeout = _now + ttl;
      }
    }
    return this.pvalue("task.heartbeat", 200, {}, [], ["task.heartbeat"]);
  }
  toPromiseRecord(sp) {
    return {
      id: sp.id,
      state: sp.state,
      param: {
        headers: sp.param?.headers ?? {},
        data: sp.param?.data ?? ""
      },
      value: {
        headers: sp.value?.headers ?? {},
        data: sp.value?.data ?? ""
      },
      tags: sp.tags,
      timeoutAt: sp.timeoutAt,
      createdAt: sp.createdAt,
      settledAt: sp.settledAt ?? undefined
    };
  }
  toTaskRecord(st) {
    return { id: st.id, state: st.state, version: st.version };
  }
  enqueueSettle(promiseId) {
    const task = this.tasks.get(promiseId);
    if (!task || task.state === "fulfilled")
      return;
    task.state = "fulfilled";
    task.pid = undefined;
    const ttIdx = this.tTimeouts.findIndex((tt) => tt.id === promiseId);
    if (ttIdx !== -1) {
      this.tTimeouts.splice(ttIdx, 1);
    }
    for (const [, promise] of this.promises) {
      const idx = promise.awaiters.indexOf(promiseId);
      if (idx !== -1) {
        promise.awaiters.splice(idx, 1);
      }
    }
  }
  resumeAwaiters(promiseId, now) {
    const settledPromise = this.promises.get(promiseId);
    if (!settledPromise)
      return;
    for (const awaiterId of settledPromise.awaiters) {
      const task = this.tasks.get(awaiterId);
      if (task && task.state === "suspended") {
        task.state = "pending";
        task.version++;
        this.tTimeouts.push({ id: awaiterId, type: 0, timeout: now + PENDING_RETRY_TTL });
        const awaiterPromise = this.getPromiseOrThrow(awaiterId);
        const address = awaiterPromise.tags["resonate:target"];
        if (address) {
          const msg = { id: awaiterId, version: task.version, address };
          this.messages.push(msg);
          this.outgoing.set(awaiterId, msg);
        }
        this.changes.push({ kind: "DidTrigger", awaiter: awaiterId });
        this.branches.push("resume_awaiter");
      }
    }
    settledPromise.awaiters = [];
  }
  getPromiseOrThrow(id) {
    const promise = this.promises.get(id);
    if (!promise) {
      throw new Error(`Invariant violation: promise ${id} not found`);
    }
    return promise;
  }
  getTTimeoutOrThrow(id) {
    const index = this.tTimeouts.findIndex((tt) => tt.id === id);
    if (index === -1) {
      throw new Error(`Invariant violation: task ${id} has no timeout entry`);
    }
    return { index, timeout: this.tTimeouts[index] };
  }
  perror(status, message, branches) {
    this.branches.push(...branches);
    return { kind: "error", head: { status }, data: message };
  }
  pvalue(kind, status, data, changes, branches) {
    this.changes.push(...changes);
    this.branches.push(...branches);
    return { kind, head: { status }, data };
  }
}

class LocalNetwork {
  pid;
  group;
  unicast;
  anycast;
  server;
  subscriptions = { execute: [], notify: [] };
  tickInterval;
  constructor({
    pid = crypto.randomUUID().replace(/-/g, ""),
    group = "default"
  } = {}) {
    this.server = new Server;
    this.pid = pid;
    this.group = group;
    this.unicast = `local://uni@${group}/${pid}`;
    this.anycast = `local://any@${group}/${pid}`;
  }
  start() {
    this.tickInterval = setInterval(() => {
      const result = this.server.apply(Date.now());
      this.dispatchMessages(result);
    }, 1000);
  }
  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }
  send(req, callback, _headers, _retryForever) {
    const { corrId, version } = req.head;
    const intercepted = this.intercept(req);
    if (intercepted) {
      callback({
        ...intercepted,
        head: { ...intercepted.head, corrId, version }
      });
      return;
    }
    const now = Date.now();
    const result = this.server.apply(now, req);
    const response = result.response;
    const res = {
      kind: response.kind,
      head: { corrId, status: response.head.status, version },
      data: response.data
    };
    this.dispatchMessages(result);
    callback(res);
  }
  getMessageSource() {
    return this;
  }
  recv(msg) {
    for (const cb of this.subscriptions[msg.kind]) {
      cb(msg);
    }
  }
  subscribe(type, callback) {
    this.subscriptions[type].push(callback);
  }
  match = (_target) => {
    return this.anycast;
  };
  intercept(req) {
    const head = { corrId: "", status: 200, version: "" };
    switch (req.kind) {
      case "promise.subscribe": {
        const sp = this.server.promises.get(req.data.awaited);
        if (!sp) {
          return {
            kind: "promise.subscribe",
            head: { corrId: "", status: 404, version: "" },
            data: "Promise not found"
          };
        }
        return { kind: "promise.subscribe", head, data: { promise: this.toPromiseRecord(sp) } };
      }
      default:
        return;
    }
  }
  dispatchMessages(result) {
    const resumeIds = new Set(result.changes.filter((c) => c.kind === "DidTrigger").map((c) => c.awaiter));
    for (const msg of result.messages) {
      const task = { id: msg.id, version: msg.version };
      if (resumeIds.has(msg.id)) {
        this.recv({ kind: "execute", head: {}, data: { task } });
      } else {
        this.recv({ kind: "execute", head: {}, data: { task } });
      }
    }
    for (const change of result.changes) {
      if (change.kind === "DidSettle") {
        const sp = this.server.promises.get(change.id);
        if (sp) {
          this.recv({
            kind: "notify",
            head: {},
            data: { promise: this.toPromiseRecord(sp) }
          });
        }
      }
    }
  }
  toPromiseRecord(sp) {
    return {
      id: sp.id,
      state: sp.state,
      param: {
        headers: sp.param?.headers ?? {},
        data: sp.param?.data ?? ""
      },
      value: {
        headers: sp.value?.headers ?? {},
        data: sp.value?.data ?? ""
      },
      tags: sp.tags,
      timeoutAt: sp.timeoutAt,
      createdAt: sp.createdAt,
      settledAt: sp.settledAt ?? undefined
    };
  }
}
// src/network/types.ts
function isSuccess(res) {
  return res.head.status === 200;
}
function isRedirect(res) {
  return res.head.status === 300;
}
function isBadRequest(res) {
  return res.head.status === 400;
}
function isNotFound(res) {
  return res.head.status === 404;
}
function isConflict(res) {
  return res.head.status === 409;
}
function isUnprocessable(res) {
  return res.head.status === 422;
}
function isRateLimited(res) {
  return res.head.status === 429;
}
function isError(res) {
  return res.head.status === 500;
}
function isNotImplemented(res) {
  return res.head.status === 501;
}
// src/promises.ts
class Promises {
  network;
  constructor(network = new LocalNetwork) {
    this.network = network;
  }
  get(id) {
    return new Promise((resolve, reject) => {
      this.network.send({ kind: "promise.get", head: { corrId: "", version: "" }, data: { id } }, (res) => {
        if (!isSuccess(res)) {
          reject(res.data);
          return;
        }
        resolve(res.data.promise);
      });
    });
  }
  create(id, timeoutAt, {
    headers = {},
    data = "",
    tags = {}
  } = {}) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "promise.create",
        head: { corrId: "", version: "" },
        data: {
          id,
          timeoutAt,
          param: { headers, data },
          tags
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(res.data);
          return;
        }
        resolve(res.data.promise);
      });
    });
  }
  createWithTask(id, timeoutAt, pid, ttl, {
    headers = {},
    data = "",
    tags = {}
  } = {}) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "task.create",
        head: { corrId: "", version: "" },
        data: {
          pid,
          ttl,
          action: {
            kind: "promise.create",
            head: { corrId: "", version: "" },
            data: { id, timeoutAt, param: { headers, data }, tags }
          }
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(res.data);
          return;
        }
        resolve({ promise: res.data.promise, task: res.data.task });
      });
    });
  }
  settle(id, state, {
    headers = {},
    data = ""
  } = {}) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "promise.settle",
        head: { corrId: "", version: "" },
        data: {
          id,
          state,
          value: { headers, data }
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(res.data);
          return;
        }
        resolve(res.data.promise);
      });
    });
  }
  register(awaited, awaiter) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "promise.register",
        head: { corrId: "", version: "" },
        data: { awaited, awaiter }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(res.data);
          return;
        }
        resolve({ promise: res.data.promise });
      });
    });
  }
  subscribe(awaited, address) {
    return new Promise((resolve, reject) => {
      this.network.send({ kind: "promise.subscribe", head: { corrId: "", version: "" }, data: { awaited, address } }, (res) => {
        if (!isSuccess(res)) {
          reject(res.data);
          return;
        }
        resolve({ promise: res.data.promise });
      });
    });
  }
}
// src/registry.ts
class Registry {
  forward = new Map;
  reverse = new Map;
  add(func, name = "", version = 1) {
    if (!(version > 0)) {
      throw exceptions_default.REGISTRY_VERSION_INVALID(version);
    }
    if (name === "" && func.name === "") {
      throw exceptions_default.REGISTRY_NAME_REQUIRED();
    }
    const funcName = name || func.name;
    if (this.get(funcName, version)) {
      throw exceptions_default.REGISTRY_FUNCTION_ALREADY_REGISTERED(funcName, version);
    }
    if (this.get(func, version)) {
      throw exceptions_default.REGISTRY_FUNCTION_ALREADY_REGISTERED(func.name, version, this.get(func, version)?.name);
    }
    const forward = this.forward.get(funcName) ?? {};
    const reverse = this.reverse.get(func) ?? {};
    forward[version] = reverse[version] = { name: funcName, func, version };
    this.forward.set(funcName, forward);
    this.reverse.set(func, reverse);
  }
  get(func, version = 0) {
    const registry = typeof func === "string" ? this.forward.get(func) : this.reverse.get(func);
    return registry?.[version > 0 ? version : this.latest(registry)];
  }
  latest(registry) {
    return Math.max(...Object.keys(registry ?? {}).map(Number) || [1]);
  }
}
// src/schedules.ts
class Schedules {
  network;
  constructor(network = new LocalNetwork) {
    this.network = network;
  }
  get(id) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "schedule.get",
        head: { corrId: "", version: "" },
        data: {
          id
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(Error("not implemented"));
          return;
        }
        resolve(res.data.schedule);
      });
    });
  }
  create(id, cron, promiseId, promiseTimeout, {
    promiseHeaders = {},
    promiseData = "",
    promiseTags = {}
  } = {}) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "schedule.create",
        head: { corrId: "", version: "" },
        data: {
          id,
          cron,
          promiseId,
          promiseTimeout,
          promiseParam: { headers: promiseHeaders, data: promiseData },
          promiseTags
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(Error("not implemented"));
          return;
        }
        resolve(res.data.schedule);
      });
    });
  }
  delete(id) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "schedule.delete",
        head: { corrId: "", version: "" },
        data: {
          id
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(Error("not implemented"));
          return;
        }
        resolve(undefined);
      });
    });
  }
}
// src/tasks.ts
class Tasks {
  network;
  constructor(network = new LocalNetwork) {
    this.network = network;
  }
  acquire(id, version, pid, ttl) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "task.acquire",
        head: { corrId: "", version: "" },
        data: {
          id,
          version,
          pid,
          ttl
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(Error("not implemented"));
          return;
        }
        resolve(res.data);
      });
    });
  }
  fulfill(id, version) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "task.fulfill",
        head: { corrId: "", version: "" },
        data: {
          id,
          version,
          action: {
            kind: "promise.settle",
            head: { corrId: "", version: "" },
            data: { id, state: "rejected", value: { headers: {}, data: "" } }
          }
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(Error("not implemented"));
          return;
        }
        resolve(res.data.promise);
      });
    });
  }
  heartbeat(pid) {
    return new Promise((resolve, reject) => {
      this.network.send({
        kind: "task.heartbeat",
        head: { corrId: "", version: "" },
        data: {
          pid,
          tasks: []
        }
      }, (res) => {
        if (!isSuccess(res)) {
          reject(Error("not implemented"));
          return;
        }
        resolve(undefined);
      });
    });
  }
}
// src/handler.ts
class Cache {
  promises = new Map;
  tasks = new Map;
  getPromise(id) {
    return this.promises.get(id);
  }
  setPromise(promise) {
    if (this.promises.get(promise.id) !== undefined && this.promises.get(promise.id)?.state !== "pending") {
      return;
    }
    this.promises.set(promise.id, promise);
  }
  evictPromises(ids) {
    ids.forEach((id) => {
      if (this.getPromise(id)?.state === "pending") {
        this.promises.delete(id);
      }
    });
  }
}

class Handler {
  cache = new Cache;
  network;
  encoder;
  encryptor;
  constructor(network, encoder, encryptor) {
    this.network = network;
    this.encoder = encoder;
    this.encryptor = encryptor;
  }
  promiseGet(req, done) {
    const promise = this.cache.getPromise(req.data.id);
    if (promise) {
      done({ kind: "value", value: promise });
      return;
    }
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
      try {
        const promise2 = this.decode(res.data.promise);
        this.cache.setPromise(promise2);
        done({ kind: "value", value: promise2 });
      } catch (e) {
        return done({ kind: "error", error: e });
      }
    });
  }
  promiseCreate(req, done, func = "unknown", headers = {}, retryForever = false) {
    const promise = this.cache.getPromise(req.data.id);
    if (promise) {
      done({ kind: "value", value: promise });
      return;
    }
    let param;
    try {
      param = this.encryptor.encrypt(this.encoder.encode(req.data.param.data));
      req.data.param = param;
    } catch (e) {
      done({
        kind: "error",
        error: exceptions_default.ENCODING_ARGS_UNENCODEABLE(req.data.param.data?.func ?? func, e)
      });
      return;
    }
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
      try {
        const promise2 = this.decode(res.data.promise, req.data.param.data?.func ?? func);
        this.cache.setPromise(promise2);
        done({ kind: "value", value: promise2 });
      } catch (e) {
        return done({ kind: "error", error: e });
      }
    }, headers, retryForever);
  }
  taskCreate(req, done, func = "unknown", headers = {}, retryForever = false) {
    let param;
    try {
      param = this.encryptor.encrypt(this.encoder.encode(req.data.action.data.param.data));
    } catch (e) {
      done({
        kind: "error",
        error: exceptions_default.ENCODING_ARGS_UNENCODEABLE(req.data.action.data.param.data?.func ?? func, e)
      });
      return;
    }
    req.data.action.data.param = param;
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
      let promise;
      try {
        promise = this.decode(res.data.promise, req.data.action.data.param.data?.func ?? func);
      } catch (e) {
        return done({ kind: "error", error: e });
      }
      this.cache.setPromise(promise);
      done({ kind: "value", value: { promise, task: res.data.task } });
    }, headers, retryForever);
  }
  promiseSettle(req, done, func = "unknown") {
    const promise = this.cache.getPromise(req.data.id);
    assertDefined(promise);
    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }
    let value;
    try {
      value = this.encryptor.encrypt(this.encoder.encode(req.data.value.data));
      req.data.value = value;
    } catch (e) {
      done({ kind: "error", error: exceptions_default.ENCODING_RETV_UNENCODEABLE(func, e) });
      return;
    }
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
      let promise2;
      try {
        promise2 = this.decode(res.data.promise, func);
      } catch (e) {
        return done({ kind: "error", error: e });
      }
      this.cache.setPromise(promise2);
      done({ kind: "value", value: promise2 });
    });
  }
  taskAcquire(req, done) {
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
      let promise;
      try {
        promise = this.decode(res.data.promise);
      } catch (e) {
        return done({ kind: "error", error: e });
      }
      this.cache.setPromise(promise);
      const task = { id: req.data.id, state: "acquired", version: req.data.version };
      done({ kind: "value", value: { task, root: promise } });
    });
  }
  taskSuspend(req, done) {
    this.cache.evictPromises(req.data.actions.map((a) => a.data.awaited));
    this.network.send(req, (res) => {
      if (isSuccess(res)) {
        return done({
          kind: "value",
          value: { continue: false }
        });
      } else if (isRedirect(res)) {
        return done({
          kind: "value",
          value: { continue: true }
        });
      } else {
        done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
    });
  }
  promiseRegister(req, done, headers = {}) {
    const id = `__resume:${req.data.awaiter}:${req.data.awaited}`;
    const promise = this.cache.getPromise(req.data.awaited);
    assertDefined(promise);
    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
      if (res.data.promise) {
        let promise2;
        try {
          promise2 = this.decode(res.data.promise);
        } catch (e) {
          return done({ kind: "error", error: e });
        }
        this.cache.setPromise(promise2);
      }
      done({ kind: "value", value: promise });
    }, headers);
  }
  promiseSubscribe(req, done, retryForever = false) {
    const id = `__notify:${req.data.awaited}:${req.data.address}`;
    const promise = this.cache.getPromise(req.data.awaited);
    assertDefined(promise);
    if (promise.state !== "pending") {
      done({ kind: "value", value: promise });
      return;
    }
    this.network.send(req, (res) => {
      if (!isSuccess(res)) {
        return done({
          kind: "error",
          error: exceptions_default.SERVER_ERROR(res.data, true, {
            code: res.head.status,
            message: res.data
          })
        });
      }
      let promise2;
      try {
        promise2 = this.decode(res.data.promise);
      } catch (e) {
        return done({ kind: "error", error: e });
      }
      this.cache.setPromise(promise2);
      done({ kind: "value", value: promise2 });
    }, {}, retryForever);
  }
  encodeValue(data, func) {
    try {
      return { kind: "value", value: this.encryptor.encrypt(this.encoder.encode(data)) };
    } catch (e) {
      return { kind: "error", error: exceptions_default.ENCODING_RETV_UNENCODEABLE(func, e) };
    }
  }
  decode(promise, func = "unknown") {
    let paramData;
    let valueData;
    try {
      paramData = this.encoder.decode(this.encryptor.decrypt(promise.param));
    } catch (e) {
      console.error(e);
      throw exceptions_default.ENCODING_ARGS_UNDECODEABLE(paramData?.func ?? func, e);
    }
    try {
      valueData = this.encoder.decode(this.encryptor.decrypt(promise.value));
    } catch (e) {
      throw exceptions_default.ENCODING_RETV_UNDECODEABLE(paramData?.func ?? func, e);
    }
    return {
      ...promise,
      param: { headers: promise.param?.headers, data: paramData },
      value: { headers: promise.value?.headers, data: valueData }
    };
  }
}
// src/heartbeat.ts
class AsyncHeartbeat {
  network;
  intervalId;
  pid;
  counter = 0;
  delay;
  constructor(pid, delay, network) {
    this.pid = pid;
    this.delay = delay;
    this.network = network;
  }
  start() {
    this.counter++;
    if (!this.intervalId) {
      this.heartbeat();
    }
  }
  heartbeat() {
    this.intervalId = setInterval(() => {
      const counter = this.counter;
      this.network.send({
        kind: "task.heartbeat",
        head: { corrId: "", version: "" },
        data: {
          pid: this.pid,
          tasks: []
        }
      }, (res) => {
        return;
      });
    }, this.delay);
  }
  stop() {
    this.clearIntervalIfMatch(this.counter);
  }
  clearIntervalIfMatch(counter) {
    if (this.counter === counter) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}

class NoopHeartbeat {
  start() {}
  stop() {}
}
// src/tracer.ts
class NoopTracer {
  startSpan(id, startTime) {
    return new NoopSpan;
  }
  decode(headers) {
    return new NoopSpan;
  }
}

class NoopSpan {
  startSpan(id, startTime) {
    return new NoopSpan;
  }
  setAttribute(key, value) {}
  setStatus(success, message) {}
  encode() {
    return {};
  }
  end(endTime) {}
}

// src/resonate.ts
class Resonate {
  clock;
  pid;
  ttl;
  idPrefix;
  unicast;
  anycast;
  match;
  core;
  network;
  encoder;
  encryptor;
  verbose;
  messageSource;
  tracer;
  handler;
  registry;
  heartbeat;
  dependencies;
  optsBuilder;
  subscriptions = new Map;
  subscribeEvery;
  intervalId;
  promises;
  schedules;
  constructor({
    url = undefined,
    group = "default",
    pid = undefined,
    ttl = 1 * MIN,
    auth = undefined,
    token = undefined,
    verbose = false,
    encryptor = undefined,
    tracer = undefined,
    transport = undefined,
    prefix = undefined
  } = {}) {
    this.clock = new WallClock;
    this.ttl = ttl;
    this.tracer = tracer ?? new NoopTracer;
    this.encryptor = encryptor ?? new NoopEncryptor;
    this.encoder = new JsonEncoder;
    const resolvedPrefix = prefix ?? process.env.RESONATE_PREFIX;
    this.idPrefix = resolvedPrefix ? `${resolvedPrefix}:` : "";
    this.verbose = verbose;
    this.subscribeEvery = 60 * 1000;
    let resolvedUrl = url;
    if (!resolvedUrl) {
      if (process.env.RESONATE_URL) {
        resolvedUrl = process.env.RESONATE_URL;
      } else {
        const resonateScheme = process.env.RESONATE_SCHEME ?? "http";
        const resonateHost = process.env.RESONATE_HOST;
        const resonatePort = process.env.RESONATE_PORT ?? "8001";
        if (resonateHost) {
          resolvedUrl = `${resonateScheme}://${resonateHost}:${resonatePort}`;
        }
      }
    }
    const resolvedToken = token ?? process.env.RESONATE_TOKEN;
    let resolvedAuth = auth;
    if (!resolvedAuth) {
      const resonateUsername = process.env.RESONATE_USERNAME;
      const resonatePassword = process.env.RESONATE_PASSWORD ?? "";
      if (resonateUsername) {
        resolvedAuth = { username: resonateUsername, password: resonatePassword };
      }
    }
    if (transport) {
      this.network = transport;
      if (isMessageSource(transport)) {
        this.messageSource = transport;
      } else if (transport.getMessageSource) {
        this.messageSource = transport.getMessageSource();
      } else {
        throw new Error("transport must implement both network and message source");
      }
      this.pid = pid ?? this.messageSource.pid;
      this.heartbeat = new AsyncHeartbeat(this.pid, ttl / 2, this.network);
    } else {
      if (!resolvedUrl) {
        const localNetwork = new LocalNetwork({ pid, group });
        this.network = localNetwork;
        this.messageSource = localNetwork.getMessageSource();
        this.pid = pid ?? this.messageSource.pid;
        this.heartbeat = new NoopHeartbeat;
      } else {
        this.network = new HttpNetwork({
          verbose: this.verbose,
          url: resolvedUrl,
          auth: resolvedAuth,
          token: resolvedToken,
          timeout: 1 * MIN,
          headers: {}
        });
        this.messageSource = new PollMessageSource({
          url: resolvedUrl,
          pid,
          group,
          auth: resolvedAuth,
          token: resolvedToken
        });
        this.pid = pid ?? this.messageSource.pid;
        this.heartbeat = new AsyncHeartbeat(this.pid, ttl / 2, this.network);
      }
    }
    this.handler = new Handler(this.network, this.encoder, this.encryptor);
    this.registry = new Registry;
    this.dependencies = new Map;
    this.unicast = this.messageSource.unicast;
    this.anycast = this.messageSource.anycast;
    this.match = this.messageSource.match;
    this.optsBuilder = new OptionsBuilder({ match: this.match, idPrefix: this.idPrefix });
    this.core = new Core({
      pid: this.pid,
      ttl: this.ttl,
      clock: this.clock,
      network: this.network,
      messageSource: this.messageSource,
      handler: this.handler,
      registry: this.registry,
      heartbeat: this.heartbeat,
      dependencies: this.dependencies,
      optsBuilder: this.optsBuilder,
      verbose: this.verbose,
      tracer: this.tracer
    });
    this.promises = new Promises(this.network);
    this.schedules = new Schedules(this.network);
    this.messageSource.subscribe("notify", this.onMessage.bind(this));
    this.intervalId = setInterval(async () => {
      for (const [id, sub] of this.subscriptions.entries()) {
        try {
          const createSubscriptionReq = {
            kind: "promise.subscribe",
            head: { corrId: "", version: "" },
            data: {
              awaited: id,
              address: this.unicast
            }
          };
          const res = await this.promiseSubscribe(createSubscriptionReq);
          if (res.state !== "pending") {
            sub.resolve(res);
            this.subscriptions.delete(id);
          }
        } catch {}
      }
    }, this.subscribeEvery);
  }
  static local({
    verbose = false,
    encryptor = undefined,
    tracer = undefined
  } = {}) {
    return new Resonate({
      group: "default",
      pid: "default",
      ttl: Number.MAX_SAFE_INTEGER,
      verbose,
      encryptor,
      tracer
    });
  }
  static remote({
    url = "http://localhost:8001",
    group = "default",
    pid = crypto.randomUUID().replace(/-/g, ""),
    ttl = 1 * MIN,
    auth = undefined,
    token = undefined,
    verbose = false,
    encryptor = undefined,
    tracer = undefined,
    prefix = undefined
  } = {}) {
    return new Resonate({ url, group, pid, ttl, auth, token, verbose, encryptor, tracer, prefix });
  }
  register(nameOrFunc, funcOrOptions, maybeOptions = {}) {
    const { version = 1 } = (typeof funcOrOptions === "object" ? funcOrOptions : maybeOptions) ?? {};
    const func = typeof nameOrFunc === "function" ? nameOrFunc : funcOrOptions;
    const name = typeof nameOrFunc === "string" ? nameOrFunc : func.name;
    this.registry.add(func, name, version);
    return {
      run: (id, ...args) => this.run(id, func, ...this.getArgsAndOpts(args, version)),
      rpc: (id, ...args) => this.rpc(id, func, ...this.getArgsAndOpts(args, version)),
      beginRun: (id, ...args) => this.beginRun(id, func, ...this.getArgsAndOpts(args, version)),
      beginRpc: (id, ...args) => this.beginRpc(id, func, ...this.getArgsAndOpts(args, version)),
      options: this.options
    };
  }
  async run(id, funcOrName, ...args) {
    return (await this.beginRun(id, funcOrName, ...args)).result();
  }
  async beginRun(id, funcOrName, ...argsWithOpts) {
    const [args, opts] = this.getArgsAndOpts(argsWithOpts);
    const registered = this.registry.get(funcOrName, opts.version);
    if (!registered) {
      throw exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(typeof funcOrName === "string" ? funcOrName : funcOrName.name, opts.version);
    }
    id = `${this.idPrefix}${id}`;
    assert(registered.version > 0, "function version must be greater than zero");
    const span = this.tracer.startSpan(id, this.clock.now());
    span.setAttribute("type", "run");
    span.setAttribute("func", registered.name);
    span.setAttribute("version", registered.version);
    try {
      const { promise, task } = await this.taskCreate({
        kind: "task.create",
        head: { corrId: "", version: "" },
        data: {
          pid: this.pid,
          ttl: this.ttl,
          action: {
            kind: "promise.create",
            head: { corrId: "", version: "" },
            data: {
              id,
              timeoutAt: Date.now() + opts.timeout,
              param: {
                data: {
                  func: registered.name,
                  args,
                  retry: opts.retryPolicy?.encode(),
                  version: registered.version
                },
                headers: {}
              },
              tags: {
                ...opts.tags,
                "resonate:origin": id,
                "resonate:branch": id,
                "resonate:parent": id,
                "resonate:scope": "global",
                "resonate:target": this.anycast
              }
            }
          }
        }
      }, span.encode());
      span.setStatus(true);
      if (task) {
        this.core.executeUntilBlocked(span, { kind: "claimed", task, rootPromise: promise }, () => {
          span.end(this.clock.now());
        });
      } else {
        span.end(this.clock.now());
      }
      return this.createHandle(promise);
    } catch (e) {
      span.setStatus(false, String(e));
      span.end(this.clock.now());
      throw e;
    }
  }
  async rpc(id, funcOrName, ...args) {
    return (await this.beginRpc(id, funcOrName, ...args)).result();
  }
  async beginRpc(id, funcOrName, ...argsWithOpts) {
    const [args, opts] = this.getArgsAndOpts(argsWithOpts);
    const registered = this.registry.get(funcOrName, opts.version);
    if (typeof funcOrName === "function" && !registered) {
      throw exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(funcOrName.name, opts.version);
    }
    id = `${this.idPrefix}${id}`;
    const func = registered ? registered.name : funcOrName;
    const version = registered ? registered.version : opts.version || 1;
    const span = this.tracer.startSpan(id, this.clock.now());
    span.setAttribute("type", "rpc");
    span.setAttribute("func", func);
    span.setAttribute("version", version);
    try {
      const promise = await this.promiseCreate({
        kind: "promise.create",
        head: { corrId: "", version: "" },
        data: {
          id,
          timeoutAt: Date.now() + opts.timeout,
          param: {
            data: {
              func,
              args,
              retry: opts.retryPolicy?.encode(),
              version
            },
            headers: {}
          },
          tags: {
            ...opts.tags,
            "resonate:origin": id,
            "resonate:branch": id,
            "resonate:parent": id,
            "resonate:scope": "global",
            "resonate:target": opts.target
          }
        }
      }, span.encode());
      span.setStatus(true);
      span.end(this.clock.now());
      return this.createHandle(promise);
    } catch (e) {
      span.setStatus(false, String(e));
      span.end(this.clock.now());
      throw e;
    }
  }
  async schedule(name, cron, funcOrName, ...argsWithOpts) {
    const [args, opts] = this.getArgsAndOpts(argsWithOpts);
    const registered = this.registry.get(funcOrName, opts.version);
    if (typeof funcOrName === "function" && !registered) {
      throw exceptions_default.REGISTRY_FUNCTION_NOT_REGISTERED(funcOrName.name, opts.version);
    }
    const { headers, data } = this.encryptor.encrypt(this.encoder.encode({
      func: registered ? registered.name : funcOrName,
      args,
      version: registered ? registered.version : opts.version || 1
    }));
    await this.schedules.create(name, cron, `${this.idPrefix}{{.id}}.{{.timestamp}}`, opts.timeout, {
      promiseHeaders: headers,
      promiseData: data,
      promiseTags: { ...opts.tags, "resonate:target": opts.target }
    });
    return {
      delete: () => this.schedules.delete(name)
    };
  }
  async get(id) {
    id = `${this.idPrefix}${id}`;
    const promise = await this.promiseGet({
      kind: "promise.get",
      head: { corrId: "", version: "" },
      data: {
        id
      }
    });
    return this.createHandle(promise);
  }
  options(opts = {}) {
    return this.optsBuilder.build(opts);
  }
  getArgsAndOpts(args, version) {
    return splitArgsAndOpts(args, this.options({ version }));
  }
  setDependency(name, obj) {
    this.dependencies.set(name, obj);
  }
  stop() {
    this.network.stop();
    this.messageSource.stop();
    this.heartbeat.stop();
    clearInterval(this.intervalId);
  }
  taskCreate(req, headers) {
    return new Promise((resolve, reject) => this.handler.taskCreate(req, (res) => {
      if (res.kind === "error") {
        reject(res.error);
      } else {
        resolve({ promise: res.value.promise, task: res.value.task });
      }
    }, undefined, headers, true));
  }
  promiseCreate(req, headers) {
    return new Promise((resolve, reject) => this.handler.promiseCreate(req, (res) => {
      if (res.kind === "error") {
        reject(res.error);
      } else {
        resolve(res.value);
      }
    }, undefined, headers, true));
  }
  promiseSubscribe(req) {
    return new Promise((resolve, reject) => this.handler.promiseSubscribe(req, (res) => {
      if (res.kind === "error") {
        reject(res.error);
      } else {
        resolve(res.value);
      }
    }, true));
  }
  promiseGet(req) {
    return new Promise((resolve, reject) => this.handler.promiseGet(req, (res) => {
      if (res.kind === "error") {
        reject(res.error);
      } else {
        resolve(res.value);
      }
    }));
  }
  createHandle(promise) {
    const createSubscriptionReq = {
      kind: "promise.subscribe",
      head: { corrId: "", version: "" },
      data: {
        awaited: promise.id,
        address: this.unicast
      }
    };
    return {
      id: promise.id,
      done: () => this.promiseSubscribe(createSubscriptionReq).then((res) => res.state !== "pending"),
      result: () => this.promiseSubscribe(createSubscriptionReq).then((res) => this.subscribe(promise.id, res))
    };
  }
  onMessage(msg) {
    assert(msg.kind === "notify");
    let paramData;
    let valueData;
    try {
      paramData = this.encoder.decode(this.encryptor.decrypt(msg.data.promise.param));
    } catch (e) {
      this.notify(msg.data.promise.id, new Error("Failed to decode promise param"));
      return;
    }
    try {
      valueData = this.encoder.decode(this.encryptor.decrypt(msg.data.promise.value));
    } catch (e) {
      this.notify(msg.data.promise.id, new Error("Failed to decode promise value"));
      return;
    }
    this.notify(msg.data.promise.id, undefined, {
      ...msg.data.promise,
      param: { headers: msg.data.promise.param.headers, data: paramData },
      value: { headers: msg.data.promise.value.headers, data: valueData }
    });
  }
  async subscribe(id, res) {
    const { promise, resolve, reject } = this.subscriptions.get(id) ?? Promise.withResolvers();
    if (res.state === "pending") {
      this.subscriptions.set(id, { promise, resolve, reject, timeout: res.timeoutAt });
    } else {
      resolve(res);
      this.subscriptions.delete(id);
    }
    const p = await promise;
    assert(p.state !== "pending", "promise must be completed");
    if (p.state === "resolved") {
      return p.value?.data;
    }
    if (p.state === "rejected") {
      throw p.value?.data;
    }
    if (p.state === "rejected_canceled") {
      throw new Error("Promise canceled");
    }
    if (p.state === "rejected_timedout") {
      throw new Error("Promise timedout");
    }
  }
  notify(id, err, res) {
    const subscription = this.subscriptions.get(id);
    if (res) {
      assert(res.state !== "pending", "promise must be completed");
      subscription?.resolve(res);
    } else {
      subscription?.reject(err);
    }
    this.subscriptions.delete(id);
  }
}
export {
  exports_essential as essential,
  WallClock,
  Resonate,
  Registry,
  OptionsBuilder,
  NoopTracer,
  NoopHeartbeat,
  NoopEncryptor,
  JsonEncoder,
  HttpNetwork,
  Handler,
  Core,
  AsyncHeartbeat
};
