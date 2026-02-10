import type { MessageSource, Network } from "./network.js";
import type { Msg, PromiseRecord, PromiseState, Req, Res, TaskRecord } from "./types.js";

// =============================================================================
// SERVER INTERNAL TYPES
//
// These types represent in-memory state that differs in shape from the SDK's
// wire types (PromiseRecord, TaskRecord, etc.).
// =============================================================================

type SettleState = "resolved" | "rejected" | "rejected_canceled";

interface Value {
  headers?: Record<string, string>;
  data?: string;
}

interface ServerPromise {
  id: string;
  state: PromiseState;
  param: Value;
  value: Value;
  tags: Record<string, string>;
  timeoutAt: number;
  createdAt: number;
  settledAt: number | null;
  awaiters: string[];
}

interface ServerTask {
  id: string;
  state: "pending" | "acquired" | "suspended" | "fulfilled";
  version: number;
  pid?: string;
  ttl?: number;
}

interface ServerMessage {
  id: string;
  version: number;
  address: string;
}

interface PTimeout {
  id: string;
  timeout: number;
}

interface TTimeout {
  id: string;
  type: 0 | 1; // 0 = pending retry, 1 = lease timeout
  timeout: number;
}

type Change =
  | { kind: "DidCreate"; id: string }
  | { kind: "DidSettle"; id: string }
  | { kind: "DidTrigger"; awaiter: string };

// Simplified server response — the Server constructs these generically via
// pvalue/perror, so we don't need per-operation response interfaces.
interface ServerResponse {
  kind: string;
  head: { status: number };
  data: any;
}

interface ServerResult {
  response: ServerResponse;
  messages: ServerMessage[];
  changes: Change[];
  branches: string[];
}

// =============================================================================
// SERVER
// =============================================================================

const PENDING_RETRY_TTL = 30000;

export class Server {
  promises = new Map<string, ServerPromise>();
  tasks = new Map<string, ServerTask>();
  pTimeouts: PTimeout[] = [];
  tTimeouts: TTimeout[] = [];
  outgoing = new Map<string, ServerMessage>();

  messages: ServerMessage[] = [];
  private changes: Change[] = [];
  private branches: string[] = [];

  apply(now: number, req?: Req): ServerResult {
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
            taskLeaseTimeouts: this.tTimeouts.filter((t) => t.type === 1).length,
          },
        },
        messages: this.messages,
        changes: this.changes,
        branches: this.branches,
      };
    }

    const response = this.dispatch(req, now);

    return {
      response,
      messages: this.messages,
      changes: this.changes,
      branches: this.branches,
    };
  }

  // ---------------------------------------------------------------------------
  // TIMEOUT PROCESSING
  // ---------------------------------------------------------------------------

  private collectTimeoutActions(
    now: number,
  ): Array<
    | { kind: "promise.settle"; data: { id: string; state: "rejected_timedout" } }
    | { kind: "task.release"; data: { id: string; version: number } }
    | { kind: "task.retry"; data: { id: string; version: number } }
  > {
    const actions: Array<
      | { kind: "promise.settle"; data: { id: string; state: "rejected_timedout" } }
      | { kind: "task.release"; data: { id: string; version: number } }
      | { kind: "task.retry"; data: { id: string; version: number } }
    > = [];

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

  private retryTask(now: number, data: { id: string; version: number }): void {
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

  // ---------------------------------------------------------------------------
  // DISPATCH
  // ---------------------------------------------------------------------------

  private dispatch(req: Req, now: number): ServerResponse {
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
      default:
        return this.perror(400, "Operation not supported", []);
    }
  }

  // ---------------------------------------------------------------------------
  // PROMISE OPERATIONS
  // ---------------------------------------------------------------------------

  private getPromise(_now: number, data: { id: string }): ServerResponse {
    const promise = this.promises.get(data.id);
    if (!promise) {
      return this.perror(404, "Promise not found", ["promise.get.not_found"]);
    }
    return this.pvalue("promise.get", 200, { promise: this.toPromiseRecord(promise) }, [], ["promise.get.found"]);
  }

  private createPromise(
    now: number,
    data: { id: string; timeoutAt: number; param?: any; tags?: Record<string, string> },
  ): ServerResponse {
    const existing = this.promises.get(data.id);
    if (existing) {
      return this.pvalue(
        "promise.create",
        200,
        { promise: this.toPromiseRecord(existing) },
        [],
        ["promise.create.exists"],
      );
    }

    const promise: ServerPromise = {
      id: data.id,
      state: "pending",
      param: data.param ?? {},
      value: {},
      tags: data.tags ?? {},
      createdAt: now,
      settledAt: null,
      timeoutAt: data.timeoutAt,
      awaiters: [],
    };
    this.promises.set(data.id, promise);
    this.pTimeouts.push({ id: data.id, timeout: data.timeoutAt });

    const invokeAddress = data.tags?.["resonate:target"];
    if (invokeAddress) {
      const task: ServerTask = { id: data.id, state: "pending", version: 0 };
      this.tasks.set(data.id, task);
      this.tTimeouts.push({ id: data.id, type: 0, timeout: now + PENDING_RETRY_TTL });
      const msg = { id: data.id, version: 0, address: invokeAddress };
      this.messages.push(msg);
      this.outgoing.set(data.id, msg);
      return this.pvalue(
        "promise.create",
        200,
        { promise: this.toPromiseRecord(promise) },
        [{ kind: "DidCreate", id: data.id }],
        ["promise.create.created_with_task"],
      );
    }

    return this.pvalue(
      "promise.create",
      200,
      { promise: this.toPromiseRecord(promise) },
      [{ kind: "DidCreate", id: data.id }],
      ["promise.create.created"],
    );
  }

  private settlePromise(
    now: number,
    data: { id: string; state: SettleState | "rejected_timedout"; value?: any },
  ): ServerResponse {
    const promise = this.promises.get(data.id);
    if (!promise) {
      return this.perror(404, "Promise not found", ["promise.settle.not_found"]);
    }
    if (promise.state !== "pending") {
      return this.pvalue(
        "promise.settle",
        200,
        { promise: this.toPromiseRecord(promise) },
        [],
        ["promise.settle.already_settled"],
      );
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

    return this.pvalue(
      "promise.settle",
      200,
      { promise: this.toPromiseRecord(promise) },
      [{ kind: "DidSettle", id: data.id }],
      [branch],
    );
  }

  private registerCallback(_now: number, data: { awaited: string; awaiter: string }): ServerResponse {
    const awaitedPromise = this.promises.get(data.awaited);
    if (!awaitedPromise) {
      return this.perror(404, "Awaited promise not found", ["promise.register.not_found"]);
    }

    const awaiterPromise = this.promises.get(data.awaiter);
    if (!awaiterPromise) {
      return this.perror(404, "Promise not found", ["promise.register.awaiter_not_found"]);
    }

    if (awaitedPromise.state !== "pending") {
      return this.pvalue(
        "promise.register",
        300,
        { promise: this.toPromiseRecord(awaitedPromise) },
        [],
        ["promise.register.awaited_settled"],
      );
    }

    let branch: string;
    if (
      awaiterPromise.state === "pending" &&
      awaiterPromise.tags["resonate:target"] != null &&
      !awaitedPromise.awaiters.includes(data.awaiter)
    ) {
      awaitedPromise.awaiters = [...awaitedPromise.awaiters, data.awaiter].sort();
      branch = "promise.register.created";
    } else if (awaitedPromise.awaiters.includes(data.awaiter)) {
      branch = "promise.register.exists";
    } else {
      branch = "promise.register.awaiter_settled";
    }

    return this.pvalue("promise.register", 200, { promise: this.toPromiseRecord(awaitedPromise) }, [], [branch]);
  }

  // ---------------------------------------------------------------------------
  // TASK OPERATIONS
  // ---------------------------------------------------------------------------

  private getTask(_now: number, data: { id: string }): ServerResponse {
    const task = this.tasks.get(data.id);
    if (!task) {
      return this.perror(404, "Task not found", ["task.get.not_found"]);
    }
    return this.pvalue("task.get", 200, { task: this.toTaskRecord(task) }, [], ["task.get.found"]);
  }

  private acquireTask(now: number, data: { id: string; version: number; pid: string; ttl: number }): ServerResponse {
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

    return this.pvalue(
      "task.acquire",
      200,
      { promise: this.toPromiseRecord(promise), preload: [] },
      [],
      ["task.acquire.invoke"],
    );
  }

  private releaseTask(now: number, data: { id: string; version: number }, isTimeout: boolean = false): ServerResponse {
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

  private fulfillTask(now: number, data: { id: string; version: number; action: any }): ServerResponse {
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
      return this.pvalue(
        "task.fulfill",
        200,
        { promise: this.toPromiseRecord(promise) },
        [],
        ["task.fulfill.already_settled"],
      );
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

    return this.pvalue(
      "task.fulfill",
      200,
      { promise: this.toPromiseRecord(promise) },
      [{ kind: "DidSettle", id: settle.id }],
      ["task.fulfill.settled"],
    );
  }

  private suspendTask(
    now: number,
    data: { id: string; version: number; actions: Array<{ data: { awaited: string; awaiter: string } }> },
  ): ServerResponse {
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
        if (
          awaitedPromise &&
          awaitedPromise.state === "pending" &&
          awaitedPromise.awaiters.includes(action.data.awaiter)
        ) {
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

  private fenceTask(now: number, data: { id: string; version: number; action: any }): ServerResponse {
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

  private fenceCreate(
    now: number,
    data: { id: string; timeoutAt: number; param?: any; tags?: Record<string, string> },
  ): ServerResponse {
    const existing = this.promises.get(data.id);
    if (existing) {
      return this.pvalue(
        "task.fence",
        200,
        {
          action: {
            kind: "promise.create",
            head: { corrId: "", status: 200, version: "" },
            data: { promise: this.toPromiseRecord(existing) },
          },
        },
        [],
        ["task.fence.create.exists"],
      );
    }

    const promise: ServerPromise = {
      id: data.id,
      state: "pending",
      param: data.param ?? {},
      value: {},
      tags: data.tags ?? {},
      createdAt: now,
      settledAt: null,
      timeoutAt: data.timeoutAt,
      awaiters: [],
    };
    this.promises.set(data.id, promise);
    this.pTimeouts.push({ id: data.id, timeout: data.timeoutAt });

    const invokeAddress = data.tags?.["resonate:target"];
    if (invokeAddress) {
      const task: ServerTask = { id: data.id, state: "pending", version: 0 };
      this.tasks.set(data.id, task);
      this.tTimeouts.push({ id: data.id, type: 0, timeout: now + PENDING_RETRY_TTL });
      const msg = { id: data.id, version: 0, address: invokeAddress };
      this.messages.push(msg);
      this.outgoing.set(data.id, msg);
      return this.pvalue(
        "task.fence",
        200,
        {
          action: {
            kind: "promise.create",
            head: { corrId: "", status: 200, version: "" },
            data: { promise: this.toPromiseRecord(promise) },
          },
        },
        [{ kind: "DidCreate", id: data.id }],
        ["task.fence.create.created_with_task"],
      );
    }

    return this.pvalue(
      "task.fence",
      200,
      {
        action: {
          kind: "promise.create",
          head: { corrId: "", status: 200, version: "" },
          data: { promise: this.toPromiseRecord(promise) },
        },
      },
      [{ kind: "DidCreate", id: data.id }],
      ["task.fence.create.created"],
    );
  }

  private fenceSettle(now: number, data: { id: string; state: SettleState; value?: any }): ServerResponse {
    const promise = this.promises.get(data.id);
    if (!promise) {
      return this.perror(404, "Promise not found", ["task.fence.settle.not_found"]);
    }
    if (promise.state !== "pending") {
      return this.pvalue(
        "task.fence",
        200,
        {
          action: {
            kind: "promise.settle",
            head: { corrId: "", status: 200, version: "" },
            data: { promise: this.toPromiseRecord(promise) },
          },
        },
        [],
        ["task.fence.settle.already_settled"],
      );
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

    return this.pvalue(
      "task.fence",
      200,
      {
        action: {
          kind: "promise.settle",
          head: { corrId: "", status: 200, version: "" },
          data: { promise: this.toPromiseRecord(promise) },
        },
      },
      [{ kind: "DidSettle", id: data.id }],
      ["task.fence.settle.settled"],
    );
  }

  private createTask(
    now: number,
    data: {
      pid: string;
      ttl: number;
      action: {
        kind: "promise.create";
        head: { auth?: string; corrId: string; version: string };
        data: {
          id: string;
          timeoutAt: number;
          param?: Value;
          tags?: Record<string, string>;
        };
      };
    },
  ): ServerResponse {
    const existingPromise = this.promises.get(data.action.data.id);
    const existingTask = this.tasks.get(data.action.data.id);

    // If promise exists without a task, fail
    if (existingPromise && !existingTask) {
      return this.perror(409, "Promise exists without associated task", ["task.create.promise_without_task"]);
    }

    // If task exists and is acquired by another process, fail
    if (existingTask && existingTask.state === "acquired" && existingTask.pid !== data.pid) {
      return this.perror(409, "Task is already acquired by another process", ["task.create.task_already_acquired"]);
    }

    // If both promise and task exist
    if (existingPromise && existingTask) {
      // Return both regardless of state (pending, completed, etc.)
      return this.pvalue(
        "task.create",
        200,
        { task: this.toTaskRecord(existingTask), promise: this.toPromiseRecord(existingPromise) },
        [],
        ["task.create.exists"],
      );
    }

    // Create new promise with task
    const promise: ServerPromise = {
      id: data.action.data.id,
      state: "pending",
      param: data.action.data.param ?? {},
      value: {},
      tags: data.action.data.tags ?? {},
      createdAt: now,
      settledAt: null,
      timeoutAt: data.action.data.timeoutAt,
      awaiters: [],
    };
    this.promises.set(data.action.data.id, promise);
    this.pTimeouts.push({ id: data.action.data.id, timeout: data.action.data.timeoutAt });

    // Create task in acquired state (this is the key difference from promise.create)
    const task: ServerTask = {
      id: data.action.data.id,
      state: "acquired",
      version: 0,
      pid: data.pid,
      ttl: data.ttl,
    };
    this.tasks.set(data.action.data.id, task);

    // Add lease timeout for acquired task
    this.tTimeouts.push({ id: data.action.data.id, type: 1, timeout: now + data.ttl });

    return this.pvalue(
      "task.create",
      200,
      { task: this.toTaskRecord(task), promise: this.toPromiseRecord(promise) },
      [{ kind: "DidCreate", id: data.action.data.id }],
      ["task.create.created"],
    );
  }

  private heartbeatTask(
    _now: number,
    data: { pid: string; tasks: Array<{ id: string; version: number }> },
  ): ServerResponse {
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

  // ---------------------------------------------------------------------------
  // CONVERTERS
  // ---------------------------------------------------------------------------

  private toPromiseRecord(sp: ServerPromise): PromiseRecord {
    return {
      id: sp.id,
      state: sp.state,
      param: {
        headers: sp.param?.headers ?? {},
        data: sp.param?.data ?? "",
      },
      value: {
        headers: sp.value?.headers ?? {},
        data: sp.value?.data ?? "",
      },
      tags: sp.tags,
      timeoutAt: sp.timeoutAt,
      createdAt: sp.createdAt,
      settledAt: sp.settledAt ?? undefined,
    };
  }

  private toTaskRecord(st: ServerTask): TaskRecord {
    return { id: st.id, version: st.version };
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  private enqueueSettle(promiseId: string): void {
    const task = this.tasks.get(promiseId);
    if (!task || task.state === "fulfilled") return;

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

  private resumeAwaiters(promiseId: string, now: number): void {
    const settledPromise = this.promises.get(promiseId);
    if (!settledPromise) return;

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

  private getPromiseOrThrow(id: string): ServerPromise {
    const promise = this.promises.get(id);
    if (!promise) {
      throw new Error(`Invariant violation: promise ${id} not found`);
    }
    return promise;
  }

  private getTTimeoutOrThrow(id: string): { index: number; timeout: TTimeout } {
    const index = this.tTimeouts.findIndex((tt) => tt.id === id);
    if (index === -1) {
      throw new Error(`Invariant violation: task ${id} has no timeout entry`);
    }
    return { index, timeout: this.tTimeouts[index] };
  }

  private perror(status: number, message: string, branches: string[]): ServerResponse {
    this.branches.push(...branches);
    return { kind: "error", head: { status }, data: message };
  }

  private pvalue(kind: string, status: number, data: unknown, changes: Change[], branches: string[]): ServerResponse {
    this.changes.push(...changes);
    this.branches.push(...branches);
    return { kind, head: { status }, data } as ServerResponse;
  }
}

// =============================================================================
// LOCAL NETWORK
// =============================================================================

export class LocalNetwork implements Network, MessageSource {
  readonly pid: string;
  readonly group: string;
  readonly unicast: string;
  readonly anycast: string;

  private server: Server;
  private subscriptions: {
    execute: Array<(msg: Msg) => void>;
    notify: Array<(msg: Msg) => void>;
  } = { execute: [], notify: [] };
  private tickInterval?: ReturnType<typeof setInterval>;

  constructor({
    pid = crypto.randomUUID().replace(/-/g, ""),
    group = "default",
  }: {
    pid?: string;
    group?: string;
  } = {}) {
    this.server = new Server();
    this.pid = pid;
    this.group = group;
    this.unicast = `local://uni@${group}/${pid}`;
    this.anycast = `local://any@${group}/${pid}`;
  }

  // -- Network ---------------------------------------------------------------

  start(): void {
    this.tickInterval = setInterval(() => {
      const result = this.server.apply(Date.now());
      this.dispatchMessages(result);
    }, 1000);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }

  send<K extends Req["kind"]>(
    req: Extract<Req, { kind: K }>,
    callback: (res: Extract<Res, { kind: K }>) => void,
    _headers?: { [key: string]: string },
    _retryForever?: boolean,
  ): void {
    const { corrId, version } = req.head;

    // Handle request kinds the Server does not implement.
    const intercepted = this.intercept(req);
    if (intercepted) {
      callback({
        ...intercepted,
        head: { ...intercepted.head, corrId, version },
      } as Extract<Res, { kind: K }>);
      return;
    }

    const now = Date.now();
    const result = this.server.apply(now, req);
    const response = result.response;

    const res = {
      kind: response.kind,
      head: { corrId, status: response.head.status, version },
      data: response.data,
    } as Extract<Res, { kind: K }>;

    this.dispatchMessages(result);

    callback(res);
  }

  getMessageSource(): MessageSource {
    return this;
  }

  // -- MessageSource ---------------------------------------------------------

  recv(msg: Msg): void {
    for (const cb of this.subscriptions[msg.kind]) {
      cb(msg);
    }
  }

  subscribe(type: "execute" | "notify", callback: (msg: Msg) => void): void {
    this.subscriptions[type].push(callback);
  }

  // Arrow function to preserve `this` when extracted as a bare reference.
  match = (_target: string): string => {
    return this.anycast;
  };

  // -- internal: intercept ---------------------------------------------------

  /**
   * Handle SDK request kinds the Server does not implement.
   * Returns a partial Res if handled, or undefined to fall through.
   */
  private intercept(req: Req): Res | undefined {
    const head = { corrId: "" as const, status: 200 as const, version: "" as const };

    switch (req.kind) {
      // promise.subscribe: look up the promise and return it.
      case "promise.subscribe": {
        const sp = this.server.promises.get(req.data.awaited);
        if (!sp) {
          return {
            kind: "promise.subscribe",
            head: { corrId: "", status: 404 as const, version: "" },
            data: "Promise not found",
          };
        }
        return { kind: "promise.subscribe", head, data: { promise: this.toPromiseRecord(sp) } };
      }

      default:
        return undefined;
    }
  }

  // -- internal: message dispatch --------------------------------------------

  private dispatchMessages(result: ServerResult): void {
    const resumeIds = new Set(
      result.changes
        .filter((c): c is { kind: "DidTrigger"; awaiter: string } => c.kind === "DidTrigger")
        .map((c) => c.awaiter),
    );

    for (const msg of result.messages) {
      const taskRecord: TaskRecord = { id: msg.id, version: msg.version };

      if (resumeIds.has(msg.id)) {
        this.recv({ kind: "execute", head: {}, data: { task: taskRecord } });
      } else {
        this.recv({ kind: "execute", head: {}, data: { task: taskRecord } });
      }
    }

    // DidSettle: send notify messages for settled promises.
    for (const change of result.changes) {
      if (change.kind === "DidSettle") {
        const sp = this.server.promises.get(change.id);
        if (sp) {
          this.recv({
            kind: "notify",
            head: {},
            data: { promise: this.toPromiseRecord(sp) },
          });
        }
      }
    }
  }

  // -- internal: type conversion ---------------------------------------------

  private toPromiseRecord(sp: ServerPromise): PromiseRecord {
    return {
      id: sp.id,
      state: sp.state,
      param: {
        headers: sp.param?.headers ?? {},
        data: sp.param?.data ?? "",
      },
      value: {
        headers: sp.value?.headers ?? {},
        data: sp.value?.data ?? "",
      },
      tags: sp.tags,
      timeoutAt: sp.timeoutAt,
      createdAt: sp.createdAt,
      settledAt: sp.settledAt ?? undefined,
    };
  }
}
