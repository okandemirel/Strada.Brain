/**
 * Agent Core v2 — Control Plane: RunClock + CallScope (ARCHITECTURE §2.3).
 *
 * The single owner of every wall-clock deadline for a run. Two scope levels only: task
 * and call. Child (call) deadlines are carved subtractively — `min(requested, taskRemaining)`
 * — so the nesting invariant `call ⊂ task` is enforced by construction, not by hand-tuned
 * cross-file ratios. Timers are real per-scope `Clock` timers re-armed on config change
 * (no 1000ms sampler). The silence ceiling is a TASK-SCOPE accumulator of total silent ms
 * across all calls — not a per-call re-armable counter — which kills the delegation livelock.
 */

import type { Clock, TimerHandle } from "./clock.js";
import type { CancelReason } from "./cancel-reason.js";
import type { CancelToken, Registration } from "./cancel-token.js";
import { createCancelToken } from "./cancel-token.js";
import type { RunBudgetPolicy } from "./policy.js";

/** Read-only view handed to child sub-agents — they read the deadline, never extend it. */
export interface RunClockView {
  now(): number;
  remainingTaskMs(): number;
}

export interface CallLimits {
  firstResponseMs: number;
  stallMs: number;
  hardMs: number;
}

export interface CallScope {
  readonly token: CancelToken; // call-level abort node (child of the task token)
  firstTokenSeen(): void; // first visible token: flip first-response → stall window
  touch(): void; // a chunk arrived: re-arm call inactivity
  registerInFlight(label: string, abort: (r: CancelReason) => void): Registration;
  leave(): void; // clears this call's timers + commits its silent contribution to the task
}

export interface RunClock {
  readonly view: RunClockView;
  readonly taskToken: CancelToken;
  enterCall(limits: CallLimits): CallScope;
  remainingTaskMs(): number;
  touchTask(): void;
  /** Total accumulated silent ms across all calls in this task (the silence accumulator). */
  accumulatedSilentMs(): number;
  silenceCeilingExceeded(): boolean;
  hardTaskExpired(): boolean;
  reArmOnConfigChange(policy: RunBudgetPolicy): void;
  dispose(): void;
}

class CallScopeImpl implements CallScope {
  readonly token: CancelToken;
  private readonly enteredAt: number;
  private lastActivityAt: number;
  private sawFirstToken = false;
  private firstResponseMs: number;
  private stallMs: number;
  private hardMs: number;
  private inactivityTimer: TimerHandle | null = null;
  private hardTimer: TimerHandle | null = null;
  private left = false;

  constructor(
    private readonly clock: Clock,
    parentToken: CancelToken,
    limits: CallLimits,
    private readonly onLeave: (silentMs: number) => void,
  ) {
    this.token = parentToken.child();
    this.firstResponseMs = limits.firstResponseMs;
    this.stallMs = limits.stallMs;
    this.hardMs = limits.hardMs;
    this.enteredAt = clock.now();
    this.lastActivityAt = this.enteredAt;
    this.armInactivity(this.firstResponseMs);
    this.armHard(this.hardMs);
  }

  private armInactivity(ms: number): void {
    if (this.inactivityTimer) this.clock.clearTimer(this.inactivityTimer);
    this.inactivityTimer = this.clock.setTimer(ms, () => {
      this.token.cancel({ kind: "provider-stall", scope: "call" });
    });
  }

  private armHard(ms: number): void {
    if (this.hardTimer) {
      this.clock.clearTimer(this.hardTimer);
      this.hardTimer = null;
    }
    if (!Number.isFinite(ms)) return;
    const elapsed = this.clock.now() - this.enteredAt;
    this.hardTimer = this.clock.setTimer(Math.max(0, ms - elapsed), () => {
      this.token.cancel({ kind: "hard-timeout", scope: "call" });
    });
  }

  firstTokenSeen(): void {
    if (this.left) return;
    this.sawFirstToken = true;
    this.lastActivityAt = this.clock.now();
    this.armInactivity(this.stallMs);
  }

  touch(): void {
    if (this.left) return;
    this.lastActivityAt = this.clock.now();
    this.armInactivity(this.sawFirstToken ? this.stallMs : this.firstResponseMs);
  }

  registerInFlight(label: string, abort: (r: CancelReason) => void): Registration {
    return this.token.registerInFlight(label, abort);
  }

  /** Re-apply (possibly changed) limits to the live scope — used by reArmOnConfigChange. */
  reArm(limits: CallLimits): void {
    if (this.left) return;
    this.firstResponseMs = limits.firstResponseMs;
    this.stallMs = limits.stallMs;
    this.hardMs = limits.hardMs;
    this.armInactivity(this.sawFirstToken ? this.stallMs : this.firstResponseMs);
    this.armHard(this.hardMs);
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    if (this.inactivityTimer) {
      this.clock.clearTimer(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.hardTimer) {
      this.clock.clearTimer(this.hardTimer);
      this.hardTimer = null;
    }
    // Silent contribution = the trailing gap since the last activity (a call that never
    // produced a token contributes its whole duration; a productive call contributes ~0).
    this.onLeave(Math.max(0, this.clock.now() - this.lastActivityAt));
  }
}

class RunClockImpl implements RunClock {
  readonly taskToken: CancelToken = createCancelToken();
  private readonly startedAt: number;
  private taskHardTimer: TimerHandle | null = null;
  private silentMsTotal = 0;
  private activeCall: CallScopeImpl | null = null;
  private disposed = false;

  constructor(
    private readonly clock: Clock,
    private policy: RunBudgetPolicy,
  ) {
    this.startedAt = clock.now();
    this.armTaskHard();
  }

  private armTaskHard(): void {
    if (this.taskHardTimer) {
      this.clock.clearTimer(this.taskHardTimer);
      this.taskHardTimer = null;
    }
    if (!Number.isFinite(this.policy.taskHardMs)) return;
    const remaining = this.remainingTaskMs();
    this.taskHardTimer = this.clock.setTimer(remaining, () => {
      this.taskToken.cancel({ kind: "hard-timeout", scope: "task" });
    });
  }

  get view(): RunClockView {
    return {
      now: () => this.clock.now(),
      remainingTaskMs: () => this.remainingTaskMs(),
    };
  }

  remainingTaskMs(): number {
    if (!Number.isFinite(this.policy.taskHardMs)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.policy.taskHardMs - (this.clock.now() - this.startedAt));
  }

  hardTaskExpired(): boolean {
    return this.remainingTaskMs() <= 0;
  }

  touchTask(): void {
    // Task-level liveness is the silence accumulator (committed per call on leave), not a
    // re-armable task timer — so a long sequence of fresh calls cannot reset it (§2.3).
    // Intentionally a no-op hook; kept for interface symmetry and future task-scope signals.
  }

  accumulatedSilentMs(): number {
    return this.silentMsTotal;
  }

  silenceCeilingExceeded(): boolean {
    return this.silentMsTotal >= this.policy.taskInactivityMs;
  }

  enterCall(limits: CallLimits): CallScope {
    const remaining = this.remainingTaskMs();
    const carved: CallLimits = {
      hardMs: Math.min(limits.hardMs, remaining),
      firstResponseMs: Math.min(limits.firstResponseMs, remaining),
      stallMs: Math.min(limits.stallMs, remaining),
    };
    const scope = new CallScopeImpl(this.clock, this.taskToken, carved, (silentMs) => {
      this.silentMsTotal += silentMs;
      if (this.activeCall === scope) this.activeCall = null;
    });
    this.activeCall = scope;
    return scope;
  }

  reArmOnConfigChange(policy: RunBudgetPolicy): void {
    this.policy = policy;
    this.armTaskHard();
    const remaining = this.remainingTaskMs();
    this.activeCall?.reArm({
      hardMs: Math.min(policy.callHardMs, remaining),
      firstResponseMs: Math.min(policy.callFirstResponseMs, remaining),
      stallMs: Math.min(policy.callStallMs, remaining),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.taskHardTimer) {
      this.clock.clearTimer(this.taskHardTimer);
      this.taskHardTimer = null;
    }
    this.activeCall?.leave();
    if (!this.taskToken.aborted) {
      // Clean teardown: abort as winddown so any lingering in-flight ops are released.
      this.taskToken.cancel({ kind: "task-winddown" });
    }
  }
}

export function openRunClock(clock: Clock, policy: RunBudgetPolicy): RunClock {
  return new RunClockImpl(clock, policy);
}
