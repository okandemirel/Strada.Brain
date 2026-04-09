import { describe, it, expect } from "vitest";
import {
  IterationHealthTracker,
  BACKOFF_SCHEDULE_MS,
} from "./iteration-health-tracker.ts";

describe("IterationHealthTracker", () => {
  it("starts with ok status and zero backoff", () => {
    const tracker = new IterationHealthTracker();
    expect(tracker.getStatusLevel()).toBe("ok");
    expect(tracker.getBackoffMs()).toBe(0);
    expect(tracker.getConsecutiveFailures()).toBe(0);
    expect(tracker.getTotalFailures()).toBe(0);
    expect(tracker.getFailureRate()).toBe(0);
  });

  it("returns retry action with escalating backoff on failures", () => {
    const tracker = new IterationHealthTracker();

    const r1 = tracker.recordFailure("openai");
    expect(r1.kind).toBe("retry");
    if (r1.kind === "retry") expect(r1.backoffMs).toBe(0);

    const r2 = tracker.recordFailure("openai");
    expect(r2.kind).toBe("retry");
    if (r2.kind === "retry") expect(r2.backoffMs).toBe(10_000);

    // Third consecutive failure triggers ask_user (>= ASK_USER_CONSECUTIVE = 3)
    const r3 = tracker.recordFailure("openai");
    expect(r3.kind).toBe("ask_user");
    if (r3.kind === "ask_user") expect(r3.backoffMs).toBe(30_000);

    const r4 = tracker.recordFailure("openai");
    expect(r4.kind).toBe("ask_user");
    if (r4.kind === "ask_user") expect(r4.backoffMs).toBe(60_000);

    // Fifth consecutive failure triggers abort (>= ABORT_CONSECUTIVE = 5)
    const r5 = tracker.recordFailure("openai");
    expect(r5.kind).toBe("abort");
  });

  it("resets backoff and consecutive count on success", () => {
    const tracker = new IterationHealthTracker();

    tracker.recordFailure("openai");
    tracker.recordFailure("openai");
    expect(tracker.getConsecutiveFailures()).toBe(2);

    tracker.recordSuccess();
    expect(tracker.getConsecutiveFailures()).toBe(0);
    expect(tracker.getBackoffMs()).toBe(0);

    // Next failure should start from backoffIndex 0 again
    const r = tracker.recordFailure("openai");
    expect(r.kind).toBe("retry");
    if (r.kind === "retry") expect(r.backoffMs).toBe(0);

    // But totalFailures should still reflect all failures
    expect(tracker.getTotalFailures()).toBe(3);
  });

  it("returns abort when failure rate exceeds threshold with consecutive failures", () => {
    const tracker = new IterationHealthTracker();

    // Build up enough failures to exceed 80% rate with 5+ consecutive
    // Need: MIN_WINDOW_FOR_RATE (5) results, >=80% failure rate, >=5 consecutive
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure("openai");
    }
    // 4 consecutive, rate = 100% — not yet 5 consecutive
    expect(tracker.getConsecutiveFailures()).toBe(4);

    // 5th consecutive failure with 100% rate should abort
    const r = tracker.recordFailure("openai");
    expect(r.kind).toBe("abort");
  });

  it("tracks status levels: ok -> degraded -> critical", () => {
    const tracker = new IterationHealthTracker();

    expect(tracker.getStatusLevel()).toBe("ok");

    tracker.recordFailure("openai");
    expect(tracker.getStatusLevel()).toBe("degraded");

    tracker.recordFailure("openai");
    expect(tracker.getStatusLevel()).toBe("degraded");

    tracker.recordFailure("openai");
    expect(tracker.getStatusLevel()).toBe("critical");

    tracker.recordSuccess();
    expect(tracker.getStatusLevel()).toBe("ok");
  });

  it("getFailureRate returns correct sliding window rate", () => {
    const tracker = new IterationHealthTracker();

    // 3 failures, 2 successes = 3/5 = 0.6
    tracker.recordFailure("a");
    tracker.recordSuccess();
    tracker.recordFailure("b");
    tracker.recordSuccess();
    tracker.recordFailure("c");

    expect(tracker.getFailureRate()).toBeCloseTo(0.6, 5);

    // Add 5 more successes => window of 10: 3 fail + 7 success in last 10
    for (let i = 0; i < 5; i++) {
      tracker.recordSuccess();
    }
    expect(tracker.getFailureRate()).toBeCloseTo(0.3, 5);
  });

  it("ask_user triggers at 3 consecutive failures", () => {
    const tracker = new IterationHealthTracker();

    // First two are retry
    expect(tracker.recordFailure("openai").kind).toBe("retry");
    expect(tracker.recordFailure("openai").kind).toBe("retry");

    // Third consecutive triggers ask_user
    const r3 = tracker.recordFailure("openai");
    expect(r3.kind).toBe("ask_user");
  });

  it("backoff caps at max value (120s)", () => {
    const tracker = new IterationHealthTracker();

    // Record many failures, interspersed with successes to prevent abort
    // but keeping backoff climbing
    // Actually, backoffIndex resets on success, so we need consecutive failures
    // to climb the schedule. We'll just check the schedule caps.

    // Record 7 consecutive failures — backoffIndex will reach beyond schedule length
    // The first 3 will be retry/ask_user, after that abort may trigger.
    // We want to verify the backoff value caps, so let's test getBackoffMs directly.
    tracker.recordFailure("openai"); // idx 0 -> 0ms, now idx=1
    tracker.recordFailure("openai"); // idx 1 -> 10s, now idx=2
    tracker.recordFailure("openai"); // idx 2 -> 30s, now idx=3
    // After 3 consecutive the status is critical but we can keep recording.
    // The ask_user/abort action still carries the backoff.

    // Reset and climb again to verify cap
    tracker.recordSuccess();

    // Now climb past the schedule length
    for (let i = 0; i < 6; i++) {
      tracker.recordFailure("openai");
    }
    // backoffIndex should be 6, schedule length is 5, so capped at index 4 = 120_000
    expect(tracker.getBackoffMs()).toBe(120_000);
  });

  it("getTaskDurationMs returns positive elapsed time", () => {
    const start = Date.now() - 5000;
    const tracker = new IterationHealthTracker(start);
    expect(tracker.getTaskDurationMs()).toBeGreaterThanOrEqual(5000);
    expect(tracker.getTaskDurationMs()).toBeLessThan(6000);
  });
});
