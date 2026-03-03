import { describe, it, expect, beforeEach } from "vitest";
import { ConfidenceScorer, calculateEloRating, wilsonScoreInterval } from "./confidence-scorer.ts";
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
