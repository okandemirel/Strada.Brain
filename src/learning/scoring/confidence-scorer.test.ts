import { describe, it, expect, beforeEach } from "vitest";
import { ConfidenceScorer, calculateEloRating, wilsonScoreInterval, getVerdictScore } from "./confidence-scorer.ts";
import type { Instinct } from "../types.ts";

describe("ConfidenceScorer", () => {
  let scorer: ConfidenceScorer;
  let baseInstinct: Instinct;

  beforeEach(() => {
    scorer = new ConfidenceScorer();
    baseInstinct = {
      id: "test-1",
      name: "Test Instinct",
      type: "error_fix",
      status: "proposed",
      confidence: 0.5,
      triggerPattern: "CS0246: The type or namespace name",
      action: "Add using directive",
      contextConditions: [],
      stats: {
        timesSuggested: 0,
        timesApplied: 0,
        timesFailed: 0,
        successRate: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  describe("calculate", () => {
    it("should calculate base confidence for new instinct", () => {
      const confidence = scorer.calculate(baseInstinct);
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    });

    it("should give higher confidence for longer trigger patterns", () => {
      const longPattern: Instinct = {
        ...baseInstinct,
        triggerPattern: "A".repeat(250),
      };
      const shortPattern: Instinct = {
        ...baseInstinct,
        triggerPattern: "short",
      };

      const longConfidence = scorer.calculate(longPattern);
      const shortConfidence = scorer.calculate(shortPattern);

      expect(longConfidence).toBeGreaterThan(shortConfidence);
    });

    it("should factor in success rate", () => {
      const highSuccess: Instinct = {
        ...baseInstinct,
        stats: { timesSuggested: 10, timesApplied: 9, timesFailed: 1, successRate: 0.9 },
      };
      const lowSuccess: Instinct = {
        ...baseInstinct,
        stats: { timesSuggested: 10, timesApplied: 3, timesFailed: 7, successRate: 0.3 },
      };

      const highConfidence = scorer.calculate(highSuccess);
      const lowConfidence = scorer.calculate(lowSuccess);

      expect(highConfidence).toBeGreaterThan(lowConfidence);
    });

    it("should apply context factors when provided", () => {
      const confidence = scorer.calculate(baseInstinct, {
        contextMatch: 0.9,
        verificationScore: 0.95,
      });

      const baseConfidence = scorer.calculate(baseInstinct);
      expect(confidence).not.toBe(baseConfidence);
    });
  });

  describe("updateConfidence", () => {
    it("should increase confidence on success", () => {
      const initialConfidence = baseInstinct.confidence;
      const updated = scorer.updateConfidence(baseInstinct, true);
      expect(updated.confidence).toBeGreaterThan(initialConfidence);
    });

    it("should decrease confidence on failure", () => {
      const initialConfidence = baseInstinct.confidence;
      const updated = scorer.updateConfidence(baseInstinct, false);
      expect(updated.confidence).toBeLessThan(initialConfidence);
    });

    it("should update success rate correctly", () => {
      let updated = scorer.updateConfidence(baseInstinct, true);
      expect(updated.stats.timesApplied).toBe(1);
      expect(updated.stats.timesFailed).toBe(0);
      expect(updated.stats.successRate).toBe(1);

      updated = scorer.updateConfidence(updated, false);
      expect(updated.stats.timesApplied).toBe(1);
      expect(updated.stats.timesFailed).toBe(1);
      expect(updated.stats.successRate).toBe(0.5);
    });

    it("should weight updates by verdict score when provided", () => {
      const strongSuccess = { ...baseInstinct };
      const weakSuccess = { ...baseInstinct };

      const updatedStrong = scorer.updateConfidence(strongSuccess, true, 1.0);
      const updatedWeak = scorer.updateConfidence(weakSuccess, true, 0.5);

      expect(updatedStrong.confidence).toBeGreaterThan(updatedWeak.confidence);
    });
  });

  describe("pure Beta posterior", () => {
    it("Beta(1,1) prior with clean success (verdictScore=0.9) produces correct alpha/beta/confidence", () => {
      // Start: alpha=1, beta=1
      // Success with verdictScore=0.9: alpha += 0.9 = 1.9, beta += 0.1 = 1.1
      // confidence = 1.9 / (1.9 + 1.1) = 1.9 / 3.0 = 0.633...
      const updated = scorer.updateConfidence(baseInstinct, true, 0.9);
      expect(updated.bayesianAlpha).toBeCloseTo(1.9, 5);
      expect(updated.bayesianBeta).toBeCloseTo(1.1, 5);
      expect(updated.confidence).toBeCloseTo(1.9 / 3.0, 5);
    });

    it("Beta(1,1) prior with hard failure (verdictScore=0.2) produces correct alpha/beta/confidence", () => {
      // Start: alpha=1, beta=1
      // Failure with verdictScore=0.2: alpha += 0.2 = 1.2, beta += 0.8 = 1.8
      // confidence = 1.2 / (1.2 + 1.8) = 1.2 / 3.0 = 0.4
      const updated = scorer.updateConfidence(baseInstinct, false, 0.2);
      expect(updated.bayesianAlpha).toBeCloseTo(1.2, 5);
      expect(updated.bayesianBeta).toBeCloseTo(1.8, 5);
      expect(updated.confidence).toBeCloseTo(1.2 / 3.0, 5);
    });

    it("Beta(10,2) with clean success produces correct alpha/beta/confidence", () => {
      // Start: alpha=10, beta=2
      // Success with verdictScore=0.9: alpha += 0.9 = 10.9, beta += 0.1 = 2.1
      // confidence = 10.9 / (10.9 + 2.1) = 10.9 / 13.0 = 0.838...
      const instinct: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 10,
        bayesianBeta: 2,
        confidence: 10 / 12, // current Beta(10,2) mean
      };
      const updated = scorer.updateConfidence(instinct, true, 0.9);
      expect(updated.bayesianAlpha).toBeCloseTo(10.9, 5);
      expect(updated.bayesianBeta).toBeCloseTo(2.1, 5);
      expect(updated.confidence).toBeCloseTo(10.9 / 13.0, 5);
    });

    it("returns instinct with updated bayesianAlpha and bayesianBeta fields", () => {
      const updated = scorer.updateConfidence(baseInstinct, true);
      expect(updated.bayesianAlpha).toBeDefined();
      expect(updated.bayesianBeta).toBeDefined();
      expect(typeof updated.bayesianAlpha).toBe("number");
      expect(typeof updated.bayesianBeta).toBe("number");
    });

    it("permanent instinct returns unchanged (frozen confidence)", () => {
      const permanent: Instinct = {
        ...baseInstinct,
        status: "permanent",
        confidence: 0.96,
        bayesianAlpha: 25,
        bayesianBeta: 2,
      };
      const updated = scorer.updateConfidence(permanent, true, 0.9);
      expect(updated).toBe(permanent); // same reference — no changes
      expect(updated.confidence).toBe(0.96);
      expect(updated.bayesianAlpha).toBe(25);
      expect(updated.bayesianBeta).toBe(2);
    });

    it("derives alpha/beta from stats when not stored on instinct", () => {
      // Instinct without bayesianAlpha/bayesianBeta — should derive from stats
      // timesApplied=5, timesFailed=2 → alpha=5+1=6, beta=2+1=3
      const instinct: Instinct = {
        ...baseInstinct,
        stats: { timesSuggested: 10, timesApplied: 5, timesFailed: 2, successRate: 0.71 },
        // No bayesianAlpha/bayesianBeta set
      };
      const updated = scorer.updateConfidence(instinct, true, 0.9);
      // Derived: alpha=6, beta=3, then success: alpha+=0.9=6.9, beta+=0.1=3.1
      expect(updated.bayesianAlpha).toBeCloseTo(6.9, 5);
      expect(updated.bayesianBeta).toBeCloseTo(3.1, 5);
    });

    it("no temporal discount applied (pure posterior only)", () => {
      // With 2 observations: alpha=2, beta=1
      const instinct: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 2,
        bayesianBeta: 1,
        confidence: 2 / 3,
        stats: { timesSuggested: 3, timesApplied: 1, timesFailed: 0, successRate: 1 },
      };
      const updated = scorer.updateConfidence(instinct, true, 0.9);
      // alpha=2.9, beta=1.1, confidence = 2.9/(2.9+1.1) = 2.9/4.0 = 0.725
      // If temporal discount were applied, result would differ
      expect(updated.confidence).toBeCloseTo(2.9 / 4.0, 5);
    });

    it("no blend factor applied (posterior mean IS the confidence)", () => {
      // With Beta(1,1) prior, success with default verdictScore=1.0:
      // alpha=2, beta=1, confidence = 2/3 = 0.667
      // If blending were applied (0.3 * posterior + 0.7 * old), result would differ
      const updated = scorer.updateConfidence(baseInstinct, true, 1.0);
      expect(updated.confidence).toBeCloseTo(2 / 3, 5);
    });

    it("initial Beta(1,1) produces mean 0.5 matching MAX_INITIAL", () => {
      // New instinct with default priors should start at 0.5
      // alpha=1, beta=1, mean = 1/(1+1) = 0.5
      expect(baseInstinct.confidence).toBe(0.5);
      // After first observation the confidence should be the posterior mean, not blended
      const updated = scorer.updateConfidence(baseInstinct, true, 0.5);
      // alpha=1.5, beta=1.5, confidence = 1.5/3.0 = 0.5
      expect(updated.confidence).toBeCloseTo(0.5, 5);
    });
  });

  describe("getStatus", () => {
    it("should return 'deprecated' for low confidence", () => {
      expect(scorer.getStatus(0.2)).toBe("deprecated");
    });

    it("should return 'active' for medium confidence", () => {
      expect(scorer.getStatus(0.75)).toBe("active");
    });

    it("should return 'evolved' for very high confidence", () => {
      expect(scorer.getStatus(0.95)).toBe("evolved");
    });

    it("should return 'proposed' for mid confidence", () => {
      expect(scorer.getStatus(0.5)).toBe("proposed");
    });

    it("should handle 'permanent' status value in getStatus", () => {
      // getStatus should not return "permanent" (promotion is managed by pipeline),
      // but it should handle the value. When confidence >= EVOLUTION, return "evolved".
      expect(scorer.getStatus(0.95)).toBe("evolved");
    });
  });

  describe("getConfidenceInterval", () => {
    it("should return valid interval bounds", () => {
      const [lower, upper] = scorer.getConfidenceInterval(baseInstinct);
      expect(lower).toBeGreaterThanOrEqual(0);
      expect(upper).toBeLessThanOrEqual(1);
      expect(lower).toBeLessThan(upper);
    });

    it("should narrow interval with more observations", () => {
      const manyObservations: Instinct = {
        ...baseInstinct,
        stats: { timesSuggested: 100, timesApplied: 90, timesFailed: 10, successRate: 0.9 },
      };
      const fewObservations: Instinct = {
        ...baseInstinct,
        stats: { timesSuggested: 5, timesApplied: 4, timesFailed: 1, successRate: 0.8 },
      };

      const [manyLower, manyUpper] = scorer.getConfidenceInterval(manyObservations);
      const [fewLower, fewUpper] = scorer.getConfidenceInterval(fewObservations);

      const manyWidth = manyUpper - manyLower;
      const fewWidth = fewUpper - fewLower;

      expect(manyWidth).toBeLessThan(fewWidth);
    });
  });

  describe("compareConfidence", () => {
    it("should sort instincts by confidence descending", () => {
      const high: Instinct = { ...baseInstinct, confidence: 0.9 };
      const low: Instinct = { ...baseInstinct, confidence: 0.3 };

      // compareConfidence returns negative when a > b (for descending sort)
      expect(scorer.compareConfidence(high, low)).toBeLessThan(0);
      expect(scorer.compareConfidence(low, high)).toBeGreaterThan(0);
    });
  });
});

describe("calculateEloRating", () => {
  it("should increase rating on win", () => {
    const initialRating = 1500;
    const newRating = calculateEloRating(initialRating, 1500, 1);
    expect(newRating).toBeGreaterThan(initialRating);
  });

  it("should decrease rating on loss", () => {
    const initialRating = 1500;
    const newRating = calculateEloRating(initialRating, 1500, 0);
    expect(newRating).toBeLessThan(initialRating);
  });

  it("should change less when favored player wins", () => {
    const highRated = 1800;
    const lowRated = 1200;

    const changeIfFavoredWins = calculateEloRating(highRated, lowRated, 1) - highRated;
    const changeIfUnderdogWins = calculateEloRating(lowRated, highRated, 1) - lowRated;

    expect(Math.abs(changeIfFavoredWins)).toBeLessThan(Math.abs(changeIfUnderdogWins));
  });
});

describe("getVerdictScore", () => {
  it("should return 0.9 for clean success (retryCount 0 or undefined)", () => {
    const result1 = getVerdictScore({ success: true });
    expect(result1).toEqual({ success: true, verdictScore: 0.9 });

    const result2 = getVerdictScore({ success: true, retryCount: 0 });
    expect(result2).toEqual({ success: true, verdictScore: 0.9 });
  });

  it("should return 0.6 for retry success (retryCount > 0)", () => {
    const result = getVerdictScore({ success: true, retryCount: 2 });
    expect(result).toEqual({ success: true, verdictScore: 0.6 });
  });

  it("should return 0.2 for hard failure", () => {
    const result = getVerdictScore({ success: false });
    expect(result).toEqual({ success: false, verdictScore: 0.2 });

    const result2 = getVerdictScore({ success: false, retryCount: 3 });
    expect(result2).toEqual({ success: false, verdictScore: 0.2 });
  });
});

describe("wilsonScoreInterval", () => {
  it("should return [0, 1] for no observations", () => {
    const interval = wilsonScoreInterval(0, 0);
    expect(interval.lower).toBe(0);
    expect(interval.upper).toBe(1);
  });

  it("should return narrow interval for high success rate with many samples", () => {
    const interval = wilsonScoreInterval(95, 100);
    expect(interval.upper - interval.lower).toBeLessThan(0.2);
  });

  it("should return wide interval for moderate success rate with few samples", () => {
    const interval = wilsonScoreInterval(3, 5);
    expect(interval.upper - interval.lower).toBeGreaterThan(0.5);
  });
});
