/**
 * Agent Core v2 — Control Plane: Clock abstraction (prerequisite P-D).
 *
 * An injectable time source so deadlines, the silence accumulator, and the incident
 * regression scenarios (3h27m runaway, ~70min stall) run deterministically under a fake
 * clock. Production uses {@link SystemClock}; tests use {@link FakeClock}. No control-plane
 * code calls global `Date.now()` / `setTimeout` directly — everything goes through a Clock.
 */

/** Opaque timer handle. Created by a Clock; only that Clock can clear it. */
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  /** Schedule `cb` after `ms` (clamped to >= 0). Returns a handle for cancellation. */
  setTimer(ms: number, cb: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/** Real wall-clock backed by `Date.now` + `setTimeout` (unref'd so it never holds the loop open). */
export class SystemClock implements Clock {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 1;

  now(): number {
    return Date.now();
  }

  setTimer(ms: number, cb: () => void): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    const handle = setTimeout(() => {
      this.timers.delete(id);
      cb();
    }, Math.max(0, ms));
    (handle as unknown as { unref?: () => void }).unref?.();
    this.timers.set(id, handle);
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(handle.id);
    }
  }
}

/** Deterministic fake clock for tests. Time advances only via {@link advance}. */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly scheduled = new Map<number, { at: number; cb: () => void }>();

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimer(ms: number, cb: () => void): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, { at: this.current + Math.max(0, ms), cb });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.scheduled.delete(handle.id);
  }

  /**
   * Advance time by `ms`, firing every due timer in chronological order — including
   * timers scheduled by a callback that are themselves due within the same window.
   */
  advance(ms: number): void {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of this.scheduled) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === -1) break;
      const due = this.scheduled.get(nextId);
      this.scheduled.delete(nextId);
      if (!due) continue;
      this.current = due.at;
      due.cb();
    }
    this.current = target;
  }

  /** Number of timers still pending (test introspection). */
  pendingTimers(): number {
    return this.scheduled.size;
  }
}
