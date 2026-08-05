// =============================================================================
// TIMERS — the liveness root
// =============================================================================
//
// Every recovery path in the protocol bottoms out in a timer: a lost `execute`
// is re-emitted by the task retry timer, a dead worker's task is reclaimed by
// the lease timer, an unsettled promise is closed by its timeout, a schedule
// fires by cron. Nothing else restarts a lineage that has stalled. A timer that
// goes missing is therefore not a delay — it is a workflow that hangs forever,
// silently.
//
// So timers are not derived from a scan. They are registered with a component
// that is always running (the broker), one schedule per lineage, armed at the
// lineage's earliest deadline. That fires with zero application processes
// alive, and the fired message is durable: if nothing is running to consume it,
// it waits until something is. No discovery, no polling, no full scan.
//
// The failure this design exists to prevent is the one `resonate-on-nats` has:
// registration happens *after* the commit (`server.go: publishTimeouts`), so a
// process that dies in between leaves a committed state with no timer and no
// path back. The fix is ordering, and it is enforced by this interface's shape:
//
//   ARM BEFORE COMMIT, with {@link TimerService.armNoLaterThan}.
//     Over-approximates. A timer may fire for a transition that never
//     committed; `tick` is version- and deadline-guarded, so it no-ops. Free.
//
//   RELAX ONLY AFTER COMMIT, with {@link TimerService.setDeadline}.
//     Moving a deadline later, or clearing it, discards protection. Doing that
//     before the commit lands would strand the state the timer was protecting.
//
// Under that discipline a timer can only ever be early or spurious — never
// missing — and the invariant is machine-checked in `tests/network/timer.test.ts`:
// the armed deadline is never later than the committed state requires.

/** One armed deadline per origin. */
export interface TimerService {
  /**
   * Ensure a timer for `origin` fires no later than `at`, moving an existing
   * one earlier if needed but never later. Safe to call before a commit,
   * because over-approximating costs only a no-op tick.
   */
  armNoLaterThan(origin: string, at: number): Promise<void>;

  /**
   * Set the authoritative deadline for `origin`, or clear it with `undefined`.
   * May move a deadline later. Call only *after* the commit that justifies it,
   * or a crash in between leaves the lineage unprotected.
   */
  setDeadline(origin: string, at: number | undefined): Promise<void>;

  /** The currently armed deadline, or undefined when none is armed. */
  deadline(origin: string): Promise<number | undefined>;
}

/**
 * In-process reference implementation.
 *
 * Fires via `setTimeout`, so it is a real timer for a single process and a
 * faithful model of the broker-backed contract for tests. Unlike a broker it
 * does not survive process death — a JetStream-backed implementation is what
 * makes the deadline durable.
 */
export class MemoryTimerService implements TimerService {
  private deadlines = new Map<string, number>();
  private handles = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    /** Invoked when a lineage's deadline arrives. */
    private readonly onFire?: (origin: string, at: number) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async armNoLaterThan(origin: string, at: number): Promise<void> {
    const current = this.deadlines.get(origin);
    if (current !== undefined && current <= at) return;
    this.schedule(origin, at);
  }

  async setDeadline(origin: string, at: number | undefined): Promise<void> {
    if (at === undefined) {
      this.deadlines.delete(origin);
      const handle = this.handles.get(origin);
      if (handle) clearTimeout(handle);
      this.handles.delete(origin);
      return;
    }
    this.schedule(origin, at);
  }

  async deadline(origin: string): Promise<number | undefined> {
    return this.deadlines.get(origin);
  }

  /** Stop every timer; for test teardown and shutdown. */
  stop(): void {
    for (const handle of this.handles.values()) clearTimeout(handle);
    this.handles.clear();
  }

  private schedule(origin: string, at: number): void {
    const existing = this.handles.get(origin);
    if (existing) clearTimeout(existing);
    this.deadlines.set(origin, at);

    if (!this.onFire) return;
    const delay = Math.max(0, at - this.now());
    const handle = setTimeout(() => {
      this.handles.delete(origin);
      this.onFire?.(origin, at);
    }, delay);
    // Never hold the event loop open on account of a pending timer.
    handle.unref?.();
    this.handles.set(origin, handle);
  }
}

/**
 * Records every call in order, without firing. Lets tests assert the *ordering
 * discipline* — that nothing relaxes a deadline before its commit — rather than
 * just the end state.
 */
export class RecordingTimerService implements TimerService {
  readonly calls: Array<{ op: "arm" | "set"; origin: string; at: number | undefined }> = [];
  private inner = new MemoryTimerService();

  async armNoLaterThan(origin: string, at: number): Promise<void> {
    this.calls.push({ op: "arm", origin, at });
    return this.inner.armNoLaterThan(origin, at);
  }

  async setDeadline(origin: string, at: number | undefined): Promise<void> {
    this.calls.push({ op: "set", origin, at });
    return this.inner.setDeadline(origin, at);
  }

  async deadline(origin: string): Promise<number | undefined> {
    return this.inner.deadline(origin);
  }
}
