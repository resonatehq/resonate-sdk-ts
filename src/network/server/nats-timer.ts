// =============================================================================
// JetStream-backed TimerService
// =============================================================================
//
// The liveness root, delegated to the one component that is always running:
// nats-server itself. No sidecar, no scheduler daemon, no extra deployment —
// message schedules are a broker feature (`allow_msg_schedules`, server 2.12+).
//
// One schedule per lineage, on `{timerPrefix}.{base64url(origin)}`:
//
//   arm     publish a message carrying `Nats-Schedule: @at <rfc3339>` and
//           `Nats-Schedule-Target: {tickPrefix}.{base64url(origin)}`. The server
//           stores it as a schedule rather than delivering it, and re-publishing
//           to the same subject REPLACES it, which is exactly the upsert the
//           runtime wants when it re-arms on every commit.
//   cancel  purge the timer subject.
//   fire    the server publishes to the target subject, inside the stream. The
//           fired message carries `Nats-Scheduler: <timer subject>`, so a
//           consumer recovers which lineage is due.
//
// Two properties were verified against a live nats-server 2.14.2, and together
// they are why this replaces a sweep rather than supplementing one:
//
//   * The schedule is durable stream state. A schedule armed before the server
//     was killed, whose deadline passed while the server was down, still fired
//     once the server came back.
//   * The fired message lands in the stream, not on the core wire. With no
//     library process running there is nothing to miss: the tick waits durably
//     until a consumer arrives.
//
// `armNoLaterThan` must never move a deadline later (see `timer.ts`), and a
// publish unconditionally replaces, so the current schedule is read before
// arming. A local cache of what this process armed keeps that read off the hot
// path; a cache miss costs one `getMessage`.

import type { TimerService } from "./timer.js";

export const DEFAULT_TIMER_PREFIX = "resonate.timers";
export const DEFAULT_TICK_PREFIX = "resonate.ticks";

/** Header the server stamps on a fired message, naming the schedule subject. */
export const SCHEDULER_HEADER = "Nats-Scheduler";
/** Header carrying the schedule specification on a stored schedule. */
export const SCHEDULE_HEADER = "Nats-Schedule";

export function encodeOrigin(origin: string): string {
  return Buffer.from(origin, "utf8").toString("base64url");
}

export function decodeOrigin(token: string): string {
  return Buffer.from(token, "base64url").toString("utf8");
}

/** Recover the origin from a fired message's `Nats-Scheduler` header. */
export function originFromScheduler(schedulerSubject: string, timerPrefix = DEFAULT_TIMER_PREFIX): string | undefined {
  if (!schedulerSubject.startsWith(`${timerPrefix}.`)) return undefined;
  return decodeOrigin(schedulerSubject.slice(timerPrefix.length + 1));
}

/**
 * The narrow slice of JetStream this service needs. Keeping it separate lets
 * the arming logic be unit-tested without a broker, while the integration test
 * drives the same logic through the real client.
 */
export interface JsTimerBinding {
  /** Publish `subject` as a schedule firing at `at`, delivered to `target`. Replaces any existing schedule on `subject`. */
  schedule(subject: string, target: string, at: number): Promise<void>;
  /** Cancel the schedule on `subject`, if any. */
  cancel(subject: string): Promise<void>;
  /** The instant the schedule on `subject` will fire, or undefined if none. */
  scheduledAt(subject: string): Promise<number | undefined>;
}

export interface JetStreamTimerConfig {
  binding: JsTimerBinding;
  timerPrefix?: string;
  tickPrefix?: string;
}

export class JetStreamTimerService implements TimerService {
  private readonly binding: JsTimerBinding;
  private readonly timerPrefix: string;
  private readonly tickPrefix: string;
  // What this process last armed, to avoid a read before every arm. Only ever
  // an optimization: on a miss the authoritative value is read from the stream.
  private cache = new Map<string, number>();

  constructor({ binding, timerPrefix = DEFAULT_TIMER_PREFIX, tickPrefix = DEFAULT_TICK_PREFIX }: JetStreamTimerConfig) {
    this.binding = binding;
    this.timerPrefix = timerPrefix;
    this.tickPrefix = tickPrefix;
  }

  timerSubject(origin: string): string {
    return `${this.timerPrefix}.${encodeOrigin(origin)}`;
  }

  tickSubject(origin: string): string {
    return `${this.tickPrefix}.${encodeOrigin(origin)}`;
  }

  async armNoLaterThan(origin: string, at: number): Promise<void> {
    const current = await this.currentDeadline(origin);
    // Never relax. A publish would replace unconditionally, so an existing
    // earlier deadline has to be left alone.
    if (current !== undefined && current <= at) return;
    await this.write(origin, at);
  }

  async setDeadline(origin: string, at: number | undefined): Promise<void> {
    if (at === undefined) {
      this.cache.delete(origin);
      await this.binding.cancel(this.timerSubject(origin));
      return;
    }
    const current = await this.currentDeadline(origin);
    if (current === at) return;
    await this.write(origin, at);
  }

  async deadline(origin: string): Promise<number | undefined> {
    return this.currentDeadline(origin);
  }

  private async write(origin: string, at: number): Promise<void> {
    await this.binding.schedule(this.timerSubject(origin), this.tickSubject(origin), at);
    this.cache.set(origin, at);
  }

  private async currentDeadline(origin: string): Promise<number | undefined> {
    const cached = this.cache.get(origin);
    if (cached !== undefined) return cached;
    const actual = await this.binding.scheduledAt(this.timerSubject(origin));
    if (actual !== undefined) this.cache.set(origin, actual);
    return actual;
  }

  /** Forget locally cached deadlines, forcing the next read to hit the stream. */
  evict(origin?: string): void {
    if (origin === undefined) this.cache.clear();
    else this.cache.delete(origin);
  }
}
