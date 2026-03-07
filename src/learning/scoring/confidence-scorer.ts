/**
 * Confidence Scorer
 * 
 * Multi-factor confidence calculation and Bayesian updating for instincts.
 * Tracks success/failure history and updates confidence using Bayesian inference.
 */

import { CONFIDENCE_THRESHOLDS, type Instinct, type InstinctStatus, type InstinctStats } from "../types.js";

// ─── Confidence Factors ─────────────────────────────────────────────────────────

interface ConfidenceFactors {
  /** Base confidence from pattern strength */
  patternStrength: number;
  /** Success rate from historical applications */
  successRate: number;
  /** Recency-weighted confidence (recent success matters more) */
  recencyScore: number;
  /** Context match quality */
  contextMatch: number;
  /** Verification score from verdicts */
  verificationScore: number;
}

interface ConfidenceWeights {
  patternStrength: number;
  successRate: number;
  recencyScore: number;
  contextMatch: number;
  verificationScore: number;
}

const DEFAULT_WEIGHTS: ConfidenceWeights = {
  patternStrength: 0.2,
  successRate: 0.35,
  recencyScore: 0.2,
  contextMatch: 0.15,
  verificationScore: 0.1,
};

// ─── Confidence Scorer Class ────────────────────────────────────────────────────

export class ConfidenceScorer {
  private weights: ConfidenceWeights;

  /** Prior belief for Bayesian updates (uninformative Beta(1,1) prior matching MAX_INITIAL=0.5) */
  private readonly priorAlpha = 1;
  private readonly priorBeta = 1;

  constructor(weights: Partial<ConfidenceWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Calculate multi-factor confidence score
   * 
   * @param instinct - The instinct to evaluate
   * @param contextFactors - Optional context-specific factors
   * @returns Overall confidence score (0.0 - 1.0)
   */
  calculate(
    instinct: Instinct,
    contextFactors?: Partial<ConfidenceFactors>
  ): number {
    const factors = this.computeFactors(instinct, contextFactors);
    
    // Weighted sum of factors
    let confidence = 0;
    confidence += factors.patternStrength * this.weights.patternStrength;
    confidence += factors.successRate * this.weights.successRate;
    confidence += factors.recencyScore * this.weights.recencyScore;
    confidence += factors.contextMatch * this.weights.contextMatch;
    confidence += factors.verificationScore * this.weights.verificationScore;

    // Apply diminishing returns for very high counts
    // (prevents runaway confidence from sheer volume)
    const totalUses = instinct.stats.timesApplied + instinct.stats.timesFailed;
    if (totalUses > 100) {
      confidence = confidence * 0.95 + 0.05;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Update confidence using pure Beta posterior inference.
   *
   * Pure Bayesian: confidence = alpha / (alpha + beta) (no blending, no temporal discount).
   * Verdict weights (0.9/0.6/0.2) are applied as fractional evidence updates.
   * Permanent instincts are frozen (returned unchanged).
   *
   * @param instinct - The instinct to update
   * @param success - Whether the application was successful
   * @param verdictScore - Optional verdict score (0.0 - 1.0) for weighted updates
   */
  updateConfidence(
    instinct: Instinct,
    success: boolean,
    verdictScore?: number
  ): Instinct {
    // Permanent instincts are frozen — no updates
    if (instinct.status === "permanent") {
      return instinct;
    }

    // Calculate new statistics
    const newTimesSuggested = instinct.stats.timesSuggested + 1;
    const newTimesApplied = instinct.stats.timesApplied + (success ? 1 : 0);
    const newTimesFailed = instinct.stats.timesFailed + (success ? 0 : 1);
    const total = newTimesApplied + newTimesFailed;
    const newSuccessRate = total > 0 ? newTimesApplied / total : 0;

    // Get current alpha/beta (use stored values, or derive from stats)
    let currentAlpha = instinct.bayesianAlpha;
    let currentBeta = instinct.bayesianBeta;
    if (currentAlpha === undefined || currentBeta === undefined) {
      // Migration case: derive from stats
      currentAlpha = instinct.stats.timesApplied + this.priorAlpha;
      currentBeta = instinct.stats.timesFailed + this.priorBeta;
    }

    // Apply verdict-weighted evidence
    // When verdictScore is provided, it acts as a fractional observation weight:
    //   Success with verdictScore=0.9: alpha += 0.9, beta += 0.1 (strong positive)
    //   Failure with verdictScore=0.2: alpha += 0.2, beta += 0.8 (strong negative)
    // When verdictScore is not provided, use full unit evidence based on success/failure.
    let newAlpha: number;
    let newBeta: number;
    if (verdictScore !== undefined) {
      // Verdict score already encodes direction: high for success, low for failure
      newAlpha = currentAlpha + verdictScore;
      newBeta = currentBeta + (1 - verdictScore);
    } else if (success) {
      newAlpha = currentAlpha + 1;
      newBeta = currentBeta;
    } else {
      newAlpha = currentAlpha;
      newBeta = currentBeta + 1;
    }

    // Pure posterior mean — no blending, no temporal discount
    const newConfidence = newAlpha / (newAlpha + newBeta);

    // Return new instinct with updated stats and Bayesian parameters
    return {
      ...instinct,
      stats: {
        ...instinct.stats,
        timesSuggested: newTimesSuggested,
        timesApplied: newTimesApplied,
        timesFailed: newTimesFailed,
        successRate: newSuccessRate,
      },
      confidence: newConfidence,
      bayesianAlpha: newAlpha,
      bayesianBeta: newBeta,
      updatedAt: Date.now() as import("../../types/index.js").TimestampMs,
    };
  }

  /**
   * Get the status based on current confidence
   */
  getStatus(confidence: number): InstinctStatus {
    if (confidence >= CONFIDENCE_THRESHOLDS.EVOLUTION) {
      return "evolved";
    } else if (confidence >= CONFIDENCE_THRESHOLDS.ACTIVE) {
      return "active";
    } else if (confidence < CONFIDENCE_THRESHOLDS.DEPRECATED) {
      return "deprecated";
    }
    return "proposed";
  }

  /**
   * Calculate confidence interval for uncertainty estimation
   * 
   * @param instinct - The instinct to evaluate
   * @param confidenceLevel - Confidence level (default 0.95)
   * @returns [lower, upper] bounds
   */
  getConfidenceInterval(
    instinct: Instinct,
    confidenceLevel: number = 0.95
  ): [number, number] {
    // Use stored alpha/beta if available, otherwise derive from stats
    const successes = instinct.bayesianAlpha ?? (instinct.stats.timesApplied + this.priorAlpha);
    const failures = instinct.bayesianBeta ?? (instinct.stats.timesFailed + this.priorBeta);
    const total = successes + failures;

    // Mean of Beta distribution
    const mean = successes / total;

    // Variance of Beta distribution
    const variance = (successes * failures) / (total * total * (total + 1));

    // Approximate standard deviation
    const stdDev = Math.sqrt(variance);

    // For 95% confidence, use approximately 2 standard deviations
    const zScore = confidenceLevel === 0.95 ? 1.96 : 
                   confidenceLevel === 0.99 ? 2.576 : 1.645;

    const margin = zScore * stdDev;
    
    return [
      Math.max(0, mean - margin),
      Math.min(1, mean + margin),
    ];
  }

  /**
   * Compare two instincts by confidence
   */
  compareConfidence(a: Instinct, b: Instinct): number {
    return b.confidence - a.confidence;
  }

  /**
   * Get detailed factor breakdown for debugging
   */
  getFactorBreakdown(
    instinct: Instinct,
    contextFactors?: Partial<ConfidenceFactors>
  ): { factors: ConfidenceFactors; weightedScore: number } {
    const factors = this.computeFactors(instinct, contextFactors);
    
    let weightedScore = 0;
    weightedScore += factors.patternStrength * this.weights.patternStrength;
    weightedScore += factors.successRate * this.weights.successRate;
    weightedScore += factors.recencyScore * this.weights.recencyScore;
    weightedScore += factors.contextMatch * this.weights.contextMatch;
    weightedScore += factors.verificationScore * this.weights.verificationScore;

    return { factors, weightedScore };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private computeFactors(
    instinct: Instinct,
    contextFactors?: Partial<ConfidenceFactors>
  ): ConfidenceFactors {
    return {
      patternStrength: contextFactors?.patternStrength ?? this.calculatePatternStrength(instinct),
      successRate: contextFactors?.successRate ?? this.calculateSuccessRate(instinct.stats),
      recencyScore: contextFactors?.recencyScore ?? this.calculateRecencyScore(instinct),
      contextMatch: contextFactors?.contextMatch ?? 0.5,
      verificationScore: contextFactors?.verificationScore ?? 0.5,
    };
  }

  private calculatePatternStrength(instinct: Instinct): number {
    let score = 0.5;

    // Longer, more specific patterns get higher base scores
    const triggerLength = instinct.triggerPattern.length;
    if (triggerLength > 200) score += 0.2;
    else if (triggerLength > 100) score += 0.1;
    else if (triggerLength < 20) score -= 0.1;

    // Specific error codes increase confidence
    if (instinct.triggerPattern.includes("CS")) score += 0.05; // C# compiler errors
    if (instinct.triggerPattern.includes("error")) score += 0.05;

    // Action specificity
    const actionLength = instinct.action.length;
    if (actionLength > 100) score += 0.1;
    else if (actionLength < 10) score -= 0.05;

    return Math.max(0, Math.min(1, score));
  }

  private calculateSuccessRate(stats: InstinctStats): number {
    const total = stats.timesApplied + stats.timesFailed;
    if (total === 0) return 0.5; // Neutral prior
    
    // Laplace smoothing
    return (stats.timesApplied + 1) / (total + 2);
  }

  private calculateRecencyScore(instinct: Instinct): number {
    const now = Date.now();
    const ageMs = now - instinct.updatedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Exponential decay based on age
    // Half-life of 30 days
    const halfLifeDays = 30;
    const decay = Math.pow(0.5, ageDays / halfLifeDays);

    // Boost for recently used instincts
    const recentUses = Math.min(instinct.stats.timesApplied, 10);
    const recencyBoost = recentUses / 20; // 0 to 0.5 boost

    return Math.min(1, decay * 0.7 + recencyBoost);
  }

}

// ─── Verdict Scoring ────────────────────────────────────────────────────────────

/**
 * Calculate weighted verdict score from a tool result event.
 * Used by handleToolResult for confidence attribution:
 *   - Clean success (no retries): strong positive (0.9)
 *   - Retry success (retryCount > 0): weak positive (0.6)
 *   - Hard failure: strong negative (0.2)
 */
export function getVerdictScore(event: { success: boolean; retryCount?: number }): { success: boolean; verdictScore: number } {
  if (event.success && (!event.retryCount || event.retryCount === 0)) {
    return { success: true, verdictScore: 0.9 };  // Clean success: strong positive
  }
  if (event.success && event.retryCount && event.retryCount > 0) {
    return { success: true, verdictScore: 0.6 };  // Retry success: weak positive
  }
  return { success: false, verdictScore: 0.2 };   // Hard failure: strong negative
}

// ─── Utility Functions ──────────────────────────────────────────────────────────

/**
 * Calculate ELO-style rating for instincts
 * Useful for ranking and tournament selection
 */
export function calculateEloRating(
  currentRating: number,
  opponentRating: number,
  result: 1 | 0.5 | 0, // win, draw, loss
  kFactor: number = 32
): number {
  const expectedScore = 1 / (1 + Math.pow(10, (opponentRating - currentRating) / 400));
  return currentRating + kFactor * (result - expectedScore);
}

/**
 * Calculate Wilson score interval for binomial proportions
 * Useful for ranking with small sample sizes
 */
export function wilsonScoreInterval(
  successes: number,
  total: number,
  confidence: number = 0.95
): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 1 };

  const z = confidence === 0.95 ? 1.96 : 
            confidence === 0.99 ? 2.576 : 1.645;
  
  const phat = successes / total;
  const z2 = z * z;
  
  const denominator = 1 + z2 / total;
  const centre = phat + z2 / (2 * total);
  const halfWidth = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);

  return {
    lower: Math.max(0, (centre - halfWidth) / denominator),
    upper: Math.min(1, (centre + halfWidth) / denominator),
  };
}
