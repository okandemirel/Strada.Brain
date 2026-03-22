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

    it("should give higher confidence for instinct with higher bayesian alpha", () => {
      // Unified model uses bayesianAlpha/Beta as the Bayesian base.
      // Instinct with high alpha (many successes) scores higher.
      const highAlpha: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 9,
        bayesianBeta: 1,
      };
      const lowAlpha: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 2,
        bayesianBeta: 8,
      };

      const highConfidence = scorer.calculate(highAlpha);
      const lowConfidence = scorer.calculate(lowAlpha);

      expect(highConfidence).toBeGreaterThan(lowConfidence);
    });

    it("should give higher confidence for instinct with higher factor scores", () => {
      // Factor multiplier: clamp(0.5, weightedAvg + 0.5, 1.5)
      // High validation/recency/consistency → higher multiplier → higher score.
      const highFactors: Instinct = {
        ...baseInstinct,
        factorRecency: 1.0,
        factorConsistency: 1.0,
        factorUserValidation: 1.0,
      };
      const lowFactors: Instinct = {
        ...baseInstinct,
        factorRecency: 0.0,
        factorConsistency: 0.0,
        factorUserValidation: 0.0,
      };

      const highConfidence = scorer.calculate(highFactors);
      const lowConfidence = scorer.calculate(lowFactors);

      expect(highConfidence).toBeGreaterThan(lowConfidence);
    });

    it("should accept context factors param (unified model derives factors from instinct fields)", () => {
      // The unified model reads factor fields from the instinct itself,
      // so passing legacy contextFactors does not change the result.
      const confidence = scorer.calculate(baseInstinct, {
        contextMatch: 0.9,
        verificationScore: 0.95,
      });

      const baseConfidence = scorer.calculate(baseInstinct);
      expect(confidence).toBe(baseConfidence);
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

  describe("unified confidence model", () => {
    it("should compute unified score = bayesian * factorMultiplier", () => {
      // alpha=8, beta=2 → posterior = 8/(8+2) = 0.8
      // factors: recency=1.0, consistency=1.0, scope=0.0, validation=1.0, session=0.0
      // weights: [0.15, 0.25, 0.15, 0.30, 0.15], sum=1.0
      // weightedAvg = (1.0*0.15 + 1.0*0.25 + 0.0*0.15 + 1.0*0.30 + 0.0*0.15) / 1.0 = 0.70
      // multiplier = clamp(0.5, 0.70 + 0.5, 1.5) = clamp(0.5, 1.2, 1.5) = 1.2
      // final = min(1.0, 0.8 * 1.2) = min(1.0, 0.96) = 0.96
      const instinct: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 8,
        bayesianBeta: 2,
        factorRecency: 1.0,
        factorConsistency: 1.0,
        factorScopeBreadth: 0.0,
        factorUserValidation: 1.0,
        factorCrossSession: 0.0,
      };
      const result = scorer.calculate(instinct);
      expect(result).toBeCloseTo(0.96, 2);
    });

    it("should clamp factor multiplier to 0.5-1.5 range", () => {
      // All factors = 0 → weightedAvg=0.0, multiplier = clamp(0.5, 0.5, 1.5) = 0.5
      const allZeroFactors: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 1,
        bayesianBeta: 1,
        factorRecency: 0.0,
        factorConsistency: 0.0,
        factorScopeBreadth: 0.0,
        factorUserValidation: 0.0,
        factorCrossSession: 0.0,
      };
      // posterior = 0.5, multiplier = 0.5 → final = 0.25
      expect(scorer.calculate(allZeroFactors)).toBeCloseTo(0.25, 5);

      // All factors = 1 → weightedAvg=1.0, multiplier = clamp(0.5, 1.5, 1.5) = 1.5
      const allOneFactors: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 1,
        bayesianBeta: 1,
        factorRecency: 1.0,
        factorConsistency: 1.0,
        factorScopeBreadth: 1.0,
        factorUserValidation: 1.0,
        factorCrossSession: 1.0,
      };
      // posterior = 0.5, multiplier = 1.5 → final = 0.75
      expect(scorer.calculate(allOneFactors)).toBeCloseTo(0.75, 5);
    });

    it("should clamp final result to [0, 1]", () => {
      // rawBayesian * factorMultiplier can exceed 1 (e.g. 0.9 * 1.5 = 1.35)
      const instinct: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 99,
        bayesianBeta: 1,  // posterior ≈ 0.99
        factorRecency: 1.0,
        factorConsistency: 1.0,
        factorScopeBreadth: 1.0,
        factorUserValidation: 1.0,
        factorCrossSession: 1.0,  // multiplier = 1.5
      };
      const result = scorer.calculate(instinct);
      expect(result).toBeLessThanOrEqual(1.0);
      expect(result).toBeGreaterThanOrEqual(0.0);
      expect(result).toBeCloseTo(1.0, 5);
    });

    it("should handle missing factor fields gracefully (default 0.5)", () => {
      // No factor fields set → all default: recency=0.5, consistency=0.5, scope=0.0, validation=0.5, session=0.0
      // weights [0.15, 0.25, 0.15, 0.30, 0.15], sum=1.0
      // weightedAvg = (0.5*0.15 + 0.5*0.25 + 0.0*0.15 + 0.5*0.30 + 0.0*0.15) / 1.0
      //             = (0.075 + 0.125 + 0.0 + 0.15 + 0.0) = 0.35
      // multiplier = clamp(0.5, 0.35 + 0.5, 1.5) = clamp(0.5, 0.85, 1.5) = 0.85
      // posterior (no alpha/beta → priors 1/1) = 0.5
      // final = 0.5 * 0.85 = 0.425
      const instinct: Instinct = { ...baseInstinct };
      const result = scorer.calculate(instinct);
      expect(result).toBeCloseTo(0.425, 5);
    });

    it("should use custom weights from config", () => {
      // Custom weights that make validation-only dominate
      const customScorer = new ConfidenceScorer({
        confidenceWeights: [0.0, 0.0, 0.0, 1.0, 0.0],
      });
      const instinct: Instinct = {
        ...baseInstinct,
        bayesianAlpha: 1,
        bayesianBeta: 1,  // posterior = 0.5
        factorUserValidation: 1.0,
        // all others default to 0.5 or 0.0 but weights are 0.0 so don't matter
      };
      // weightedAvg = (0*recency + 0*consistency + 0*scope + 1.0*validation + 0*session) / 1.0 = 1.0
      // multiplier = clamp(0.5, 1.5, 1.5) = 1.5
      // final = 0.5 * 1.5 = 0.75
      expect(customScorer.calculate(instinct)).toBeCloseTo(0.75, 5);
    });

    it("should return intervention tier based on confidence", () => {
      expect(scorer.getInterventionTier(0.9)).toBe('auto');
      expect(scorer.getInterventionTier(0.81)).toBe('auto');
      expect(scorer.getInterventionTier(0.8)).toBe('warn');   // exactly 0.8 → NOT auto (requires > 0.8)
      expect(scorer.getInterventionTier(0.6)).toBe('warn');   // exactly 0.6 → warn (>= 0.6)
      expect(scorer.getInterventionTier(0.5)).toBe('suggest');
      expect(scorer.getInterventionTier(0.3)).toBe('suggest'); // exactly 0.3 → suggest (>= 0.3)
      expect(scorer.getInterventionTier(0.29)).toBe('passive');
      expect(scorer.getInterventionTier(0.0)).toBe('passive');
    });

    it("should handle exact boundary values deterministically", () => {
      // Boundary: > 0.8 required for auto
      expect(scorer.getInterventionTier(0.800001)).toBe('auto');
      expect(scorer.getInterventionTier(0.8)).toBe('warn');
      // Boundary: >= 0.6 for warn
      expect(scorer.getInterventionTier(0.6)).toBe('warn');
      expect(scorer.getInterventionTier(0.599)).toBe('suggest');
      // Boundary: >= 0.3 for suggest
      expect(scorer.getInterventionTier(0.3)).toBe('suggest');
      expect(scorer.getInterventionTier(0.299)).toBe('passive');
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
