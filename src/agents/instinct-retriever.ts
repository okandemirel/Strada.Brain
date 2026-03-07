/**
 * Instinct Retriever
 *
 * Proactively retrieves relevant learning insights for a given task description.
 * Uses PatternMatcher to find similar instincts and formats them as human-readable strings.
 * Returns both formatted insights and raw instinct IDs for metrics recording (EVAL-03).
 */

import type { PatternMatcher } from "../learning/matching/pattern-matcher.js";
import type { PatternMatch } from "../learning/types.js";

/** Result from getInsightsForTask containing both formatted strings and raw IDs */
export interface InsightResult {
  /** Formatted human-readable insight strings */
  readonly insights: string[];
  /** Raw instinct IDs for metrics storage (EVAL-03 pattern reuse tracking) */
  readonly matchedInstinctIds: string[];
}

export class InstinctRetriever {
  constructor(
    private readonly matcher: PatternMatcher,
  ) {}

  /**
   * Retrieve formatted insight strings and matched instinct IDs for a task.
   *
   * @param taskDescription - Natural-language description of the current task
   * @param maxInsights - Maximum number of insights to return (default 5)
   * @returns InsightResult with formatted strings and raw instinct IDs
   */
  async getInsightsForTask(taskDescription: string, maxInsights: number = 5): Promise<InsightResult> {
    // Find similar instincts using the pattern matcher (single scan)
    const matches = this.matcher.findSimilarInstincts(taskDescription, {
      minSimilarity: 0.4,
      maxResults: maxInsights,
    });

    const insights: string[] = [];
    const matchedInstinctIds: string[] = [];

    for (const match of matches) {
      if (match.instinct) {
        matchedInstinctIds.push(match.instinct.id);
      }
      const formatted = this.formatInsight(match);
      if (formatted !== null) {
        insights.push(formatted);
      }
    }

    return { insights, matchedInstinctIds };
  }

  /**
   * Format a pattern match into a human-readable insight string.
   *
   * @param match - The pattern match to format
   * @returns Formatted string or null if the action JSON cannot be parsed
   */
  private formatInsight(match: PatternMatch): string | null {
    if (!match.instinct) {
      return null;
    }

    try {
      const action = JSON.parse(match.instinct.action) as { description?: string };

      if (!action.description) {
        return null;
      }

      const confidence = Math.round(match.instinct.confidence * 100);
      const successRate = Math.round(match.instinct.stats.successRate * 100);
      const applied = match.instinct.stats.timesApplied;

      return `${action.description} (${confidence}% confidence, ${successRate}% success, applied ${applied}x)`;
    } catch {
      return null;
    }
  }
}
