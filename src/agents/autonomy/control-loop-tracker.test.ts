import { describe, expect, it } from "vitest";
import { ControlLoopTracker } from "./control-loop-tracker.js";

describe("ControlLoopTracker", () => {
  it("triggers when the same fingerprint repeats within the short window", () => {
    const tracker = new ControlLoopTracker();

    expect(tracker.recordGate({
      kind: "verifier_continue",
      reason: "Still need runtime replay",
      gate: "[VERIFIER PIPELINE: CONTINUE REQUIRED]",
      iteration: 1,
    })).toBeNull();

    expect(tracker.recordGate({
      kind: "verifier_continue",
      reason: "Still need runtime replay",
      gate: "[VERIFIER PIPELINE: CONTINUE REQUIRED]",
      iteration: 3,
    })).toBeNull();

    expect(tracker.recordGate({
      kind: "verifier_continue",
      reason: "Still need runtime replay",
      gate: "[VERIFIER PIPELINE: CONTINUE REQUIRED]",
      iteration: 6,
    })).toBeNull();

    expect(tracker.recordGate({
      kind: "verifier_continue",
      reason: "Still need runtime replay",
      gate: "[VERIFIER PIPELINE: CONTINUE REQUIRED]",
      iteration: 9,
    })).toBeNull();

    const trigger = tracker.recordGate({
      kind: "verifier_continue",
      reason: "Still need runtime replay",
      gate: "[VERIFIER PIPELINE: CONTINUE REQUIRED]",
      iteration: 11,
    });

    expect(trigger?.reason).toBe("same_fingerprint_repeated");
    expect(trigger?.sameFingerprintCount).toBe(5);
  });

  it("resets its window after clean verification", () => {
    const tracker = new ControlLoopTracker();

    tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "Need more local evidence",
      gate: "keep working",
      iteration: 1,
    });
    tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "Need more local evidence",
      gate: "keep working",
      iteration: 4,
    });
    tracker.markVerificationClean(5);

    const trigger = tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "Need more local evidence",
      gate: "keep working",
      iteration: 9,
    });

    expect(trigger).toBeNull();
  });

  it("escalates the recovery episode counter after each recovery attempt", () => {
    const tracker = new ControlLoopTracker();

    for (let i = 1; i <= 4; i++) {
      tracker.recordGate({
        kind: "visibility_internal_continue",
        reason: "Draft still deflects to the user",
        gate: "keep internal",
        iteration: i,
      });
    }
    const firstTrigger = tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 5,
    });

    const episode = tracker.markRecoveryAttempt(firstTrigger!.fingerprint);
    expect(episode).toBe(1);

    for (let i = 10; i <= 13; i++) {
      tracker.recordGate({
        kind: "visibility_internal_continue",
        reason: "Draft still deflects to the user",
        gate: "keep internal",
        iteration: i,
      });
    }
    const secondTrigger = tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 14,
    });

    expect(secondTrigger?.recoveryEpisode).toBe(1);
  });

  it("uses custom fingerprint threshold from config", () => {
    const tracker = new ControlLoopTracker({ sameFingerprintThreshold: 6, sameFingerprintWindow: 20 });
    const event = { kind: "verifier_continue" as const, reason: "test", iteration: 1 };
    // 5 events should NOT trigger (threshold is 6)
    for (let i = 1; i <= 5; i++) {
      expect(tracker.recordGate({ ...event, iteration: i })).toBeNull();
    }
    // 6th should trigger
    expect(tracker.recordGate({ ...event, iteration: 6 })).not.toBeNull();
  });

  it("default fingerprint threshold is 5", () => {
    const tracker = new ControlLoopTracker();
    const event = { kind: "verifier_continue" as const, reason: "test", iteration: 1 };
    for (let i = 1; i <= 4; i++) {
      expect(tracker.recordGate({ ...event, iteration: i })).toBeNull();
    }
    expect(tracker.recordGate({ ...event, iteration: 5 })).not.toBeNull();
  });

  it("exposes maxRecoveryEpisodes from config", () => {
    const tracker = new ControlLoopTracker({ maxRecoveryEpisodes: 10 });
    expect(tracker.maxRecoveryEpisodes).toBe(10);
  });
});
