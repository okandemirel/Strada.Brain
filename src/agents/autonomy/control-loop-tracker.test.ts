import { describe, expect, it } from "vitest";
import { ControlLoopTracker } from "./control-loop-tracker.js";

describe("ControlLoopTracker", () => {
  it("triggers when the same fingerprint repeats within the short window", () => {
    // Disable stale analysis, use explicit fpThreshold to isolate fingerprint behavior
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100, sameFingerprintThreshold: 3 });

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

    const trigger = tracker.recordGate({
      kind: "verifier_continue",
      reason: "Still need runtime replay",
      gate: "[VERIFIER PIPELINE: CONTINUE REQUIRED]",
      iteration: 6,
    });

    expect(trigger?.reason).toBe("same_fingerprint_repeated");
    expect(trigger?.sameFingerprintCount).toBe(3);
  });

  it("resets its window after clean verification", () => {
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });

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
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100, sameFingerprintThreshold: 3 });

    for (let i = 1; i <= 2; i++) {
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
      iteration: 3,
    });

    const episode = tracker.markRecoveryAttempt(firstTrigger!.fingerprint);
    expect(episode).toBe(1);

    for (let i = 10; i <= 11; i++) {
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
      iteration: 12,
    });

    expect(secondTrigger?.recoveryEpisode).toBe(1);
  });

  it("uses custom fingerprint threshold from config", () => {
    const tracker = new ControlLoopTracker({
      sameFingerprintThreshold: 6,
      sameFingerprintWindow: 20,
      gateDensityThreshold: 100,
      staleAnalysisThreshold: 100,
    });
    const event = { kind: "verifier_continue" as const, reason: "test", iteration: 1 };
    // 5 events should NOT trigger (threshold is 6)
    for (let i = 1; i <= 5; i++) {
      expect(tracker.recordGate({ ...event, iteration: i })).toBeNull();
    }
    // 6th should trigger
    expect(tracker.recordGate({ ...event, iteration: 6 })).not.toBeNull();
  });

  it("default fingerprint threshold is 15", () => {
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    const event = { kind: "verifier_continue" as const, reason: "test", iteration: 1 };
    for (let i = 1; i <= 14; i++) {
      expect(tracker.recordGate({ ...event, iteration: i })).toBeNull();
    }
    expect(tracker.recordGate({ ...event, iteration: 15 })).not.toBeNull();
  });

  it("exposes maxRecoveryEpisodes from config", () => {
    const tracker = new ControlLoopTracker({ maxRecoveryEpisodes: 10 });
    expect(tracker.maxRecoveryEpisodes).toBe(10);
  });

  // ─── Stale Analysis Detection ──────────────────────────────────────────────

  it("triggers stale_analysis_loop after consecutive gates without tool execution", () => {
    const tracker = new ControlLoopTracker();

    for (let i = 1; i <= 9; i++) {
      expect(tracker.recordGate({
        kind: "clarification_internal_continue",
        reason: "Clarification review kept the task internal.",
        iteration: i,
      })).toBeNull();
    }

    const trigger = tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "Clarification review kept the task internal.",
      iteration: 10,
    });

    expect(trigger).not.toBeNull();
    expect(trigger?.reason).toBe("stale_analysis_loop");
    expect(trigger?.sameFingerprintCount).toBe(10);
  });

  it("resets stale analysis counter on markToolExecution", () => {
    // Use high fingerprint/density thresholds to isolate stale analysis behavior
    const tracker = new ControlLoopTracker({
      sameFingerprintThreshold: 100,
      gateDensityThreshold: 100,
      staleAnalysisThreshold: 3,
    });

    tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 1,
    });
    tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 2,
    });

    // Tool execution resets the stale counter
    tracker.markToolExecution();

    // Should not trigger — stale counter was reset
    expect(tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 3,
    })).toBeNull();

    expect(tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 4,
    })).toBeNull();

    // 3rd gate after reset — should trigger
    const trigger = tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 5,
    });
    expect(trigger?.reason).toBe("stale_analysis_loop");
  });

  it("resets stale analysis counter on markVerificationClean", () => {
    const tracker = new ControlLoopTracker();

    tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 1,
    });
    tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 2,
    });

    tracker.markVerificationClean(3);

    // Counter reset — next 2 gates should not trigger
    expect(tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 4,
    })).toBeNull();

    expect(tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 5,
    })).toBeNull();
  });

  it("resets stale analysis counter on markMeaningfulFileEvidence with new files", () => {
    const tracker = new ControlLoopTracker();

    tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "test",
      iteration: 1,
    });
    tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "test",
      iteration: 2,
    });

    tracker.markMeaningfulFileEvidence(["src/foo.ts"], 3);

    // Counter reset
    expect(tracker.recordGate({
      kind: "visibility_internal_continue",
      reason: "test",
      iteration: 4,
    })).toBeNull();
  });

  it("stale analysis triggers before fingerprint matching when threshold is lower", () => {
    // Default stale threshold is 3, fingerprint threshold is 3
    // Stale analysis is checked first in recordGate
    const tracker = new ControlLoopTracker({
      sameFingerprintThreshold: 5,
      staleAnalysisThreshold: 3,
    });

    const event = {
      kind: "clarification_internal_continue" as const,
      reason: "same reason every time",
      iteration: 1,
    };

    tracker.recordGate({ ...event, iteration: 1 });
    tracker.recordGate({ ...event, iteration: 2 });
    const trigger = tracker.recordGate({ ...event, iteration: 3 });

    // Should trigger as stale_analysis_loop, not same_fingerprint_repeated
    expect(trigger?.reason).toBe("stale_analysis_loop");
  });

  it("incrementTextOnlyGate increments counter without recording gate event", () => {
    const tracker = new ControlLoopTracker({ staleAnalysisThreshold: 100 });
    tracker.incrementTextOnlyGate();
    tracker.incrementTextOnlyGate();
    expect(tracker.getConsecutiveTextOnlyGates()).toBe(2);
    const trigger = tracker.recordGate({
      kind: "clarification_internal_continue",
      reason: "test",
      iteration: 1,
    });
    expect(trigger).toBeNull();
  });

  it("getConsecutiveTextOnlyGates returns current counter value", () => {
    const tracker = new ControlLoopTracker();
    expect(tracker.getConsecutiveTextOnlyGates()).toBe(0);
    tracker.incrementTextOnlyGate();
    expect(tracker.getConsecutiveTextOnlyGates()).toBe(1);
    tracker.markToolExecution();
    expect(tracker.getConsecutiveTextOnlyGates()).toBe(0);
  });

  it("custom staleAnalysisThreshold from config", () => {
    const tracker = new ControlLoopTracker({
      sameFingerprintThreshold: 100,
      gateDensityThreshold: 100,
      staleAnalysisThreshold: 5,
    });

    const event = {
      kind: "clarification_internal_continue" as const,
      reason: "test",
      iteration: 1,
    };

    for (let i = 1; i <= 4; i++) {
      expect(tracker.recordGate({ ...event, iteration: i })).toBeNull();
    }
    const trigger = tracker.recordGate({ ...event, iteration: 5 });
    expect(trigger?.reason).toBe("stale_analysis_loop");
  });

  it("mixed gate kinds still accumulate stale analysis counter", () => {
    const tracker = new ControlLoopTracker({ sameFingerprintThreshold: 100, gateDensityThreshold: 100 });

    const kinds = [
      "clarification_internal_continue",
      "visibility_internal_continue",
      "verifier_continue",
      "verifier_replan",
    ] as const;

    // Different kinds — fingerprint won't match, but stale analysis should still fire at threshold (default=10)
    for (let i = 1; i <= 9; i++) {
      expect(tracker.recordGate({
        kind: kinds[i % kinds.length]!,
        reason: `test ${i}`,
        iteration: i,
      })).toBeNull();
    }

    const trigger = tracker.recordGate({
      kind: "verifier_replan",
      reason: "test 10",
      iteration: 10,
    });

    expect(trigger?.reason).toBe("stale_analysis_loop");
  });
});
