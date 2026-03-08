/**
 * Circuit Breaker with Exponential Backoff
 *
 * Implements the CLOSED -> OPEN -> HALF_OPEN -> CLOSED state machine
 * for per-trigger failure resilience in the daemon heartbeat loop.
 *
 * - CLOSED: Trigger evaluates normally
 * - OPEN: Trigger is skipped (too many failures); transitions to HALF_OPEN after cooldown
 * - HALF_OPEN: Allows one trial; success -> CLOSED, failure -> OPEN with doubled cooldown
 *
 * Used by: HeartbeatLoop (Plan 04) for per-trigger circuit breaking
 */

import type { CircuitState } from "../daemon-types.js";

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private cooldownMs: number;

  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(
    failureThreshold: number,
    baseCooldownMs: number,
    maxCooldownMs: number,
  ) {
    this.failureThreshold = failureThreshold;
    this.baseCooldownMs = baseCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.cooldownMs = baseCooldownMs;
  }

  /**
   * Check if the circuit is open (blocking trigger evaluation).
   *
   * - CLOSED: returns false (allow evaluation)
   * - OPEN: checks if cooldown expired; if yes, transitions to HALF_OPEN and returns false
   * - HALF_OPEN: returns false (allow one trial)
   */
  isOpen(): boolean {
    if (this.state === "CLOSED") {
      return false;
    }

    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cooldownMs) {
        this.state = "HALF_OPEN";
        return false;
      }
      return true;
    }

    // HALF_OPEN -- allow one trial
    return false;
  }

  /**
   * Record a successful execution.
   * In HALF_OPEN, transitions to CLOSED and resets counters.
   */
  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED";
      this.consecutiveFailures = 0;
      this.cooldownMs = this.baseCooldownMs;
    }
  }

  /**
   * Record a failed execution.
   * Increments failure count, records time. If threshold reached or in HALF_OPEN,
   * transitions to OPEN with doubled cooldown (capped at max).
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      // Double cooldown on HALF_OPEN failure, capped at max
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.state = "OPEN";
    } else if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  /**
   * Force the circuit back to CLOSED state, resetting all counters.
   */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.cooldownMs = this.baseCooldownMs;
  }

  /**
   * Get the current circuit state.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Serialize state for persistence via DaemonStorage.
   */
  serialize(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
      cooldownMs: this.cooldownMs,
    };
  }

  /**
   * Restore a CircuitBreaker from persisted state.
   */
  static deserialize(
    data: CircuitBreakerSnapshot,
    failureThreshold: number,
    baseCooldownMs: number,
    maxCooldownMs: number,
  ): CircuitBreaker {
    const breaker = new CircuitBreaker(failureThreshold, baseCooldownMs, maxCooldownMs);
    breaker.state = data.state;
    breaker.consecutiveFailures = data.consecutiveFailures;
    breaker.lastFailureTime = data.lastFailureTime;
    breaker.cooldownMs = data.cooldownMs;
    return breaker;
  }
}
