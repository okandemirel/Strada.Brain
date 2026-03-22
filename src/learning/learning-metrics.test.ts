import { describe, it, expect, beforeEach } from "vitest";
import { LearningMetrics } from "./learning-metrics.js";

describe("LearningMetrics", () => {
  beforeEach(() => {
    LearningMetrics.reset();
  });

  it("singleton returns the same instance", () => {
    const a = LearningMetrics.getInstance();
    const b = LearningMetrics.getInstance();
    expect(a).toBe(b);
  });

  it("reset() clears counters and creates a new instance", () => {
    const a = LearningMetrics.getInstance();
    a.recordReflectionDone();
    expect(a.getReflectionStats().totalDone).toBe(1);

    LearningMetrics.reset();
    const b = LearningMetrics.getInstance();
    expect(b).not.toBe(a);
    expect(b.getReflectionStats().totalDone).toBe(0);
  });

  describe("reflection stats", () => {
    it("records done and override correctly", () => {
      const m = LearningMetrics.getInstance();
      m.recordReflectionDone();
      m.recordReflectionDone();
      m.recordReflectionOverride();

      const stats = m.getReflectionStats();
      expect(stats.totalDone).toBe(2);
      expect(stats.totalOverrides).toBe(1);
      expect(stats.overrideRate).toBe(0.5);
    });

    it("overrideRate is 0 when no reflections done (no divide-by-zero)", () => {
      const m = LearningMetrics.getInstance();
      const stats = m.getReflectionStats();
      expect(stats.totalDone).toBe(0);
      expect(stats.totalOverrides).toBe(0);
      expect(stats.overrideRate).toBe(0);
    });
  });

  describe("consensus stats", () => {
    it("tracks agreement rate", () => {
      const m = LearningMetrics.getInstance();
      m.recordConsensusResult({ agreed: true, strategy: "review", reasoning: "ok" });
      m.recordConsensusResult({ agreed: true, strategy: "review", reasoning: "ok" });
      m.recordConsensusResult({ agreed: false, strategy: "re-execute", reasoning: "mismatch" });

      const stats = m.getConsensusStats();
      expect(stats.totalVerifications).toBe(3);
      expect(stats.agreementRate).toBeCloseTo(2 / 3);
      expect(stats.disagreements).toHaveLength(1);
      expect(stats.disagreements[0]!.strategy).toBe("re-execute");
    });

    it("caps disagreements at 50", () => {
      const m = LearningMetrics.getInstance();
      for (let i = 0; i < 60; i++) {
        m.recordConsensusResult({ agreed: false, strategy: "review", reasoning: `entry-${i}` });
      }
      const stats = m.getConsensusStats();
      expect(stats.disagreements).toHaveLength(50);
      // Oldest entries should have been shifted out; first entry should be entry-10
      expect(stats.disagreements[0]!.reasoning).toBe("entry-10");
      expect(stats.disagreements[49]!.reasoning).toBe("entry-59");
    });

    it("returns 0 agreement rate when no verifications", () => {
      const m = LearningMetrics.getInstance();
      expect(m.getConsensusStats().agreementRate).toBe(0);
    });

    it("disagreements array is a copy (not a reference)", () => {
      const m = LearningMetrics.getInstance();
      m.recordConsensusResult({ agreed: false, strategy: "review", reasoning: "test" });
      const d1 = m.getConsensusStats().disagreements;
      const d2 = m.getConsensusStats().disagreements;
      expect(d1).not.toBe(d2);
      expect(d1).toEqual(d2);
    });
  });

  describe("outcome stats", () => {
    it("calculates successRate correctly", () => {
      const m = LearningMetrics.getInstance();
      m.recordOutcome({ success: true, instinctCount: 2 });
      m.recordOutcome({ success: false, instinctCount: 1 });
      m.recordOutcome({ success: true, instinctCount: 3 });

      const stats = m.getOutcomeStats();
      expect(stats.totalTracked).toBe(3);
      expect(stats.successRate).toBeCloseTo(2 / 3);
      expect(stats.instinctsUpdated).toBe(6);
    });

    it("returns 0 success rate when no outcomes tracked", () => {
      const m = LearningMetrics.getInstance();
      expect(m.getOutcomeStats().successRate).toBe(0);
      expect(m.getOutcomeStats().totalTracked).toBe(0);
    });
  });
});
