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
      iteration: 6,
    })).toBeNull();

    const trigger = tracker.recordGate({
      kind: "verifier_continue",
      reason: "Still need runtime replay",
      gate: "[VERIFIER PIPELINE: CONTINUE REQUIRED]",
      iteration: 11,
    });

    expect(trigger?.reason).toBe("same_fingerprint_repeated");
    expect(trigger?.sameFingerprintCount).toBe(3);
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

    tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 1,
    });
    tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 2,
    });
    const firstTrigger = tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 3,
    });

    const episode = tracker.markRecoveryAttempt(firstTrigger!.fingerprint);
    expect(episode).toBe(1);

    tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 10,
    });
    tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 11,
    });
    const secondTrigger = tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "Draft still deflects to the user",
      gate: "keep internal",
      iteration: 12,
    });

    expect(secondTrigger?.recoveryEpisode).toBe(1);
  });
});
