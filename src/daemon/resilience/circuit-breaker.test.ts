import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;
  const FAILURE_THRESHOLD = 3;
  const BASE_COOLDOWN_MS = 60_000;
  const MAX_COOLDOWN_MS = 3_600_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00Z"));
    breaker = new CircuitBreaker(FAILURE_THRESHOLD, BASE_COOLDOWN_MS, MAX_COOLDOWN_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Initial state
  // =========================================================================

  it("starts in CLOSED state with isOpen() returning false", () => {
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.isOpen()).toBe(false);
  });

  // =========================================================================
  // CLOSED -> OPEN transition
  // =========================================================================

  it("transitions to OPEN after failureThreshold consecutive failures", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("CLOSED");

    breaker.recordFailure(); // 3rd failure = threshold
    expect(breaker.getState()).toBe("OPEN");
  });

  it("isOpen() returns true when in OPEN state", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen()).toBe(true);
  });

  // =========================================================================
  // OPEN -> HALF_OPEN transition
  // =========================================================================

  it("transitions to HALF_OPEN after cooldown expires, isOpen() returns false", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe("OPEN");

    // Advance past the cooldown
    vi.advanceTimersByTime(BASE_COOLDOWN_MS);

    // isOpen() should detect cooldown expired and transition to HALF_OPEN
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  // =========================================================================
  // HALF_OPEN -> CLOSED on success
  // =========================================================================

  it("recordSuccess() in HALF_OPEN transitions to CLOSED, resets failures and cooldown", () => {
    // Move to HALF_OPEN
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure();
    }
    vi.advanceTimersByTime(BASE_COOLDOWN_MS);
    breaker.isOpen(); // trigger transition to HALF_OPEN

    breaker.recordSuccess();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.isOpen()).toBe(false);
  });

  // =========================================================================
  // HALF_OPEN -> OPEN on failure with doubled cooldown
  // =========================================================================

  it("recordFailure() in HALF_OPEN transitions to OPEN with doubled cooldown", () => {
    // Move to HALF_OPEN
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure();
    }
    vi.advanceTimersByTime(BASE_COOLDOWN_MS);
    breaker.isOpen(); // trigger transition to HALF_OPEN

    breaker.recordFailure();
    expect(breaker.getState()).toBe("OPEN");

    // Now cooldown should be doubled: 120_000
    // Advance only the original cooldown -- should still be OPEN
    vi.advanceTimersByTime(BASE_COOLDOWN_MS);
    expect(breaker.isOpen()).toBe(true);

    // Advance to the doubled cooldown
    vi.advanceTimersByTime(BASE_COOLDOWN_MS); // total = 2 * BASE
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  // =========================================================================
  // Exponential backoff cap
  // =========================================================================

  it("cooldown doubles on each HALF_OPEN failure, capped at maxCooldownMs", () => {
    const smallBreaker = new CircuitBreaker(1, 1000, 4000);

    // First failure -> OPEN with 1000ms cooldown
    smallBreaker.recordFailure();
    expect(smallBreaker.getState()).toBe("OPEN");

    // Cooldown 1000ms -> HALF_OPEN
    vi.advanceTimersByTime(1000);
    smallBreaker.isOpen();
    expect(smallBreaker.getState()).toBe("HALF_OPEN");

    // Fail in HALF_OPEN -> OPEN with 2000ms cooldown
    smallBreaker.recordFailure();
    expect(smallBreaker.getState()).toBe("OPEN");
    vi.advanceTimersByTime(2000);
    smallBreaker.isOpen();
    expect(smallBreaker.getState()).toBe("HALF_OPEN");

    // Fail in HALF_OPEN -> OPEN with 4000ms cooldown (capped)
    smallBreaker.recordFailure();
    expect(smallBreaker.getState()).toBe("OPEN");
    vi.advanceTimersByTime(4000);
    smallBreaker.isOpen();
    expect(smallBreaker.getState()).toBe("HALF_OPEN");

    // Fail again -> still capped at 4000ms (not 8000ms)
    smallBreaker.recordFailure();
    expect(smallBreaker.getState()).toBe("OPEN");
    vi.advanceTimersByTime(4000);
    smallBreaker.isOpen();
    expect(smallBreaker.getState()).toBe("HALF_OPEN");
  });

  // =========================================================================
  // Reset
  // =========================================================================

  it("reset() forces CLOSED state regardless of current state", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe("OPEN");

    breaker.reset();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.isOpen()).toBe(false);
  });

  // =========================================================================
  // getState correctness
  // =========================================================================

  it("getState() returns correct CircuitState at each stage", () => {
    expect(breaker.getState()).toBe("CLOSED");

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe("OPEN");

    vi.advanceTimersByTime(BASE_COOLDOWN_MS);
    breaker.isOpen();
    expect(breaker.getState()).toBe("HALF_OPEN");

    breaker.recordSuccess();
    expect(breaker.getState()).toBe("CLOSED");
  });

  // =========================================================================
  // Serialize / Deserialize
  // =========================================================================

  it("serialize/deserialize round-trips state for persistence", () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure();
    }

    const serialized = breaker.serialize();
    expect(serialized.state).toBe("OPEN");
    expect(serialized.consecutiveFailures).toBe(FAILURE_THRESHOLD);
    expect(serialized.lastFailureTime).toBeGreaterThan(0);
    expect(serialized.cooldownMs).toBe(BASE_COOLDOWN_MS);

    const restored = CircuitBreaker.deserialize(
      serialized,
      FAILURE_THRESHOLD,
      BASE_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
    );
    expect(restored.getState()).toBe("OPEN");
    expect(restored.isOpen()).toBe(true);
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  it("recordSuccess in CLOSED state is a no-op (stays CLOSED)", () => {
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("partial failures below threshold do not transition to OPEN", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.isOpen()).toBe(false);
  });
});
