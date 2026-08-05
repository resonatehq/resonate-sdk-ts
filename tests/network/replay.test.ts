import { describe, expect, test } from "@jest/globals";
import { type Change, Server } from "../../src/network/local.js";
import { emptySnapshot, fold, hydrate, snapshot } from "../../src/network/server/state.js";
import type { Request } from "../../src/network/types.js";
import { VERSION } from "../../src/util.js";

// =============================================================================
// REPLAY DETERMINISM
// =============================================================================
//
// The event-sourced runtime commits a request by appending its `Change[]` to a
// durable log, and recovers state by replaying that log. That is only sound if
// the log is a *complete* description of the transition:
//
//     fold(all changes emitted so far) === snapshot(server)
//
// These tests drive randomized but protocol-valid request sequences through the
// machine and assert the invariant after every single step, so a divergence is
// reported at the request that caused it rather than at the end of a run.

// Seeded LCG, same generator the DST uses (`sim/src/simulator.ts`), so runs are
// reproducible from the seed printed in a failure.
class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  randint(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(list: T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
}

function head() {
  return { corrId: "c", version: VERSION };
}

/**
 * Serialize with object keys sorted, so comparison is insensitive to insertion
 * order. `fold` populates records in log order and `snapshot` in Map order; the
 * two agree on content but not on key order, and only content is meaningful.
 * Arrays keep their order — for callbacks and listeners it is significant.
 */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return val;
  });
}

const TARGET = "local://any@default";

/**
 * A tiny model of what the SDK does to a server: keep track of the ids it has
 * created and the task versions it believes it holds, so the generator can emit
 * sequences that actually exercise the interesting transitions (acquire the
 * right version, suspend on a promise that exists, fulfil a task it holds)
 * rather than bouncing off 404s and 409s.
 */
class Workload {
  private n = 0;
  promises: string[] = [];
  tasks = new Map<string, number>();

  constructor(
    private rng: Random,
    private root: string,
  ) {}

  private nextId(): string {
    this.n += 1;
    return `${this.root}.p${this.n}`;
  }

  next(now: number): Request {
    const choices = [
      "create",
      "createTarget",
      "settle",
      "callback",
      "listener",
      "acquire",
      "suspend",
      "fulfill",
      "get",
    ];
    const kind = this.rng.pick(choices);

    switch (kind) {
      case "create":
      case "createTarget": {
        const id = this.nextId();
        this.promises.push(id);
        const tags: Record<string, string> =
          kind === "createTarget" ? { "resonate:target": TARGET, "resonate:branch": this.root } : {};
        if (kind === "createTarget") this.tasks.set(id, 0);
        return {
          kind: "promise.create",
          head: head(),
          // A mix of live and already-expired deadlines, so the immediate-timeout
          // branches of promise.create get exercised too.
          data: { id, timeoutAt: now + this.rng.pick([-1000, 5000, 60000]), param: {}, tags },
        };
      }
      case "settle": {
        if (this.promises.length === 0) return this.get();
        return {
          kind: "promise.settle",
          head: head(),
          data: {
            id: this.rng.pick(this.promises),
            state: this.rng.pick(["resolved", "rejected", "rejected_canceled"] as const),
            value: { data: "v" },
          },
        };
      }
      case "callback": {
        if (this.promises.length < 2) return this.get();
        const awaited = this.rng.pick(this.promises);
        const awaiter = this.rng.pick([...this.tasks.keys()]) ?? this.rng.pick(this.promises);
        if (awaited === awaiter) return this.get();
        return { kind: "promise.register_callback", head: head(), data: { awaited, awaiter } };
      }
      case "listener": {
        if (this.promises.length === 0) return this.get();
        return {
          kind: "promise.register_listener",
          head: head(),
          data: { awaited: this.rng.pick(this.promises), address: `local://uni@default/${this.rng.randint(1, 3)}` },
        };
      }
      case "acquire": {
        if (this.tasks.size === 0) return this.get();
        const id = this.rng.pick([...this.tasks.keys()]);
        const version = this.tasks.get(id)!;
        // Track the version the server would move to, so later suspend/fulfill
        // requests mostly hit the matching-version path.
        this.tasks.set(id, version + 1);
        return { kind: "task.acquire", head: head(), data: { id, version, pid: "pid", ttl: 30000 } };
      }
      case "suspend": {
        if (this.tasks.size === 0 || this.promises.length === 0) return this.get();
        const id = this.rng.pick([...this.tasks.keys()]);
        const awaited = this.promises.find((p) => p !== id);
        if (!awaited) return this.get();
        return {
          kind: "task.suspend",
          head: head(),
          data: {
            id,
            version: this.tasks.get(id)!,
            actions: [{ kind: "promise.register_callback", head: head(), data: { awaited, awaiter: id } }],
          },
        };
      }
      case "fulfill": {
        if (this.tasks.size === 0) return this.get();
        const id = this.rng.pick([...this.tasks.keys()]);
        return {
          kind: "task.fulfill",
          head: head(),
          data: {
            id,
            version: this.tasks.get(id)!,
            action: {
              kind: "promise.settle",
              head: head(),
              data: { id, state: "resolved", value: { data: "done" } },
            },
          },
        };
      }
      default:
        return this.get();
    }
  }

  private get(): Request {
    return {
      kind: "promise.get",
      head: head(),
      data: { id: this.promises.length ? this.rng.pick(this.promises) : "missing" },
    };
  }
}

describe("change log completeness", () => {
  test("a promise.set carries the awaiter graph", () => {
    // The regression this guards: `toPromiseRecord` strips `callbacks` and
    // `listeners`, so a change carrying only a PromiseRecord cannot describe
    // who is awaiting the promise, and replay silently loses the edge.
    const server = new Server();
    const now = 1000;

    server.apply(now, {
      kind: "promise.create",
      head: head(),
      data: { id: "root", timeoutAt: now + 60000, param: {}, tags: { "resonate:target": TARGET } },
    });
    server.apply(now, {
      kind: "promise.create",
      head: head(),
      data: { id: "child", timeoutAt: now + 60000, param: {}, tags: {} },
    });
    const { changes } = server.apply(now, {
      kind: "promise.register_callback",
      head: head(),
      data: { awaited: "child", awaiter: "root" },
    });

    const set = changes.find((c): c is Extract<Change, { kind: "promise.set" }> => c.kind === "promise.set");
    expect(set).toBeDefined();
    expect(set!.callbacks).toEqual(["root"]);
  });

  test("a promise.set carries registered listeners", () => {
    const server = new Server();
    const now = 1000;
    server.apply(now, {
      kind: "promise.create",
      head: head(),
      data: { id: "p", timeoutAt: now + 60000, param: {}, tags: {} },
    });
    const { changes } = server.apply(now, {
      kind: "promise.register_listener",
      head: head(),
      data: { awaited: "p", address: "local://uni@default/1" },
    });

    const set = changes.find((c): c is Extract<Change, { kind: "promise.set" }> => c.kind === "promise.set");
    expect(set!.listeners).toEqual(["local://uni@default/1"]);
  });
});

describe("replay determinism", () => {
  test("folding the log of a hand-built lineage reproduces server state", () => {
    const server = new Server();
    const log: Change[] = [];
    const now = 1000;

    const push = (req: Request, at = now) => log.push(...server.apply(at, req).changes);

    push({
      kind: "promise.create",
      head: head(),
      data: {
        id: "root",
        timeoutAt: now + 60000,
        param: { data: "in" },
        tags: { "resonate:target": TARGET, "resonate:branch": "root" },
      },
    });
    push({ kind: "task.acquire", head: head(), data: { id: "root", version: 0, pid: "pid", ttl: 30000 } });
    push({
      kind: "promise.create",
      head: head(),
      data: { id: "root.child", timeoutAt: now + 60000, param: {}, tags: {} },
    });
    push({
      kind: "task.suspend",
      head: head(),
      data: {
        id: "root",
        version: 1,
        actions: [
          { kind: "promise.register_callback", head: head(), data: { awaited: "root.child", awaiter: "root" } },
        ],
      },
    });
    push({
      kind: "promise.settle",
      head: head(),
      data: { id: "root.child", state: "resolved", value: { data: "out" } },
    });

    expect(fold(log)).toEqual(snapshot(server));
  });

  test("the invariant holds after every step of randomized sequences", () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = new Random(seed);
      const server = new Server();
      const workload = new Workload(rng, "root");
      const log: Change[] = [];
      let now = 1000;

      for (let step = 0; step < 40; step++) {
        // Advance time irregularly so eager timeout convergence fires mid-run.
        now += rng.pick([0, 0, 0, 1000, 45000]);
        const req = workload.next(now);
        log.push(...server.apply(now, req).changes);

        const replayed = fold(log);
        const direct = snapshot(server);
        // Report only the component that diverged; dumping whole snapshots
        // buries the signal.
        for (const key of Object.keys(direct) as (keyof typeof direct)[]) {
          const a = canon(replayed[key]);
          const b = canon(direct[key]);
          if (a !== b) {
            throw new Error(
              `replay diverged in "${key}" at seed=${seed} step=${step} after ${req.kind} ` +
                `(${JSON.stringify(req.data)})\n  replayed: ${a}\n  direct:   ${b}`,
            );
          }
        }
      }
    }
  });

  test("replay is incremental: folding onto a prior snapshot equals folding from empty", () => {
    // Snapshot-plus-tail recovery must agree with full replay, which is what
    // lets the runtime trim the log behind a checkpoint.
    for (let seed = 0; seed < 50; seed++) {
      const rng = new Random(seed);
      const server = new Server();
      const workload = new Workload(rng, "root");
      const log: Change[] = [];
      let now = 1000;
      let checkpoint = emptySnapshot();
      let checkpointAt = 0;

      for (let step = 0; step < 30; step++) {
        now += rng.pick([0, 0, 1000, 45000]);
        log.push(...server.apply(now, workload.next(now)).changes);

        if (step === 14) {
          checkpoint = fold(log);
          checkpointAt = log.length;
        }
      }

      const fromEmpty = fold(log);
      const fromCheckpoint = fold(log.slice(checkpointAt), checkpoint);
      expect(fromCheckpoint).toEqual(fromEmpty);
      expect(fromEmpty).toEqual(snapshot(server));
    }
  });

  test("hydrate round-trips a snapshot", () => {
    const rng = new Random(7);
    const server = new Server();
    const workload = new Workload(rng, "root");
    let now = 1000;
    for (let i = 0; i < 30; i++) {
      now += rng.pick([0, 1000, 45000]);
      server.apply(now, workload.next(now));
    }
    const snap = snapshot(server);
    expect(canon(snapshot(hydrate(snap)))).toEqual(canon(snap));
  });
});

describe("recovery", () => {
  // The failure mode that motivates the whole design: a process holding a
  // lineage dies. Recovery replays the log into a fresh machine, and that
  // machine must be *behaviourally* identical — not merely structurally equal.
  // Structural equality is checked above; here we check that the recovered
  // machine answers subsequent requests the same way the original would have.
  test("a machine recovered from the log is indistinguishable from the original", () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = new Random(seed);
      const original = new Server();
      const workload = new Workload(rng, "root");
      const log: Change[] = [];
      let now = 1000;

      // Phase 1: build up history on the original, capturing the log.
      for (let i = 0; i < 20; i++) {
        now += rng.pick([0, 0, 1000, 45000]);
        log.push(...original.apply(now, workload.next(now)).changes);
      }

      // Phase 2: "crash" — rebuild a machine from the log alone.
      const recovered = hydrate(fold(log));
      expect(canon(snapshot(recovered))).toEqual(canon(snapshot(original)));

      // Phase 3: drive both with identical subsequent requests. Responses must
      // agree at every step, and so must the resulting state.
      for (let i = 0; i < 20; i++) {
        now += rng.pick([0, 0, 1000, 45000]);
        const req = workload.next(now);
        const a = original.apply(now, req);
        const b = recovered.apply(now, req);

        if (canon(a.response) !== canon(b.response)) {
          throw new Error(
            `recovered machine diverged at seed=${seed} step=${i} on ${req.kind}\n` +
              `  original:  ${canon(a.response)}\n  recovered: ${canon(b.response)}`,
          );
        }
        if (canon(a.changes) !== canon(b.changes)) {
          throw new Error(
            `recovered machine emitted a different log at seed=${seed} step=${i} on ${req.kind}\n` +
              `  original:  ${canon(a.changes)}\n  recovered: ${canon(b.changes)}`,
          );
        }
      }

      expect(canon(snapshot(recovered))).toEqual(canon(snapshot(original)));
    }
  });

  test("recovery from a checkpoint plus tail matches recovery from the full log", () => {
    for (let seed = 0; seed < 50; seed++) {
      const rng = new Random(seed + 500);
      const server = new Server();
      const workload = new Workload(rng, "root");
      const log: Change[] = [];
      let now = 1000;
      let checkpoint = emptySnapshot();
      let cut = 0;

      for (let i = 0; i < 30; i++) {
        now += rng.pick([0, 1000, 45000]);
        log.push(...server.apply(now, workload.next(now)).changes);
        if (i === 9) {
          // Trim point: everything before `cut` is subsumed by the checkpoint.
          checkpoint = fold(log);
          cut = log.length;
        }
      }

      const fromFull = hydrate(fold(log));
      const fromTrimmed = hydrate(fold(log.slice(cut), checkpoint));
      expect(canon(snapshot(fromTrimmed))).toEqual(canon(snapshot(fromFull)));
    }
  });
});

describe("change log completeness (reset)", () => {
  test("a reset is described by the log", () => {
    const server = new Server();
    const log: Change[] = [];
    const now = 1000;
    log.push(
      ...server.apply(now, {
        kind: "promise.create",
        head: head(),
        data: { id: "p", timeoutAt: now + 60000, param: {}, tags: {} },
      }).changes,
    );
    log.push(...server.apply(now, { kind: "debug.reset", head: head(), data: {} }).changes);

    expect(fold(log)).toEqual(snapshot(server));
    expect(fold(log).promises).toEqual({});
  });
});
