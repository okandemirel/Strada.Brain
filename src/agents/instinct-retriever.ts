/**
 * Instinct Retriever
 *
 * Proactively retrieves relevant learning insights for a given task description.
 * Uses PatternMatcher to find similar instincts and formats them as human-readable strings.
 */

import type { PatternMatcher } from "../learning/matching/pattern-matcher.js";
import type { LearningStorage } from "../learning/storage/learning-storage.js";
import type { PatternMatch } from "../learning/types.js";

export class InstinctRetriever {
  constructor(
    private readonly matcher: PatternMatcher,
    private readonly storage: LearningStorage,
  ) {}

  /**
   * Retrieve formatted insight strings relevant to a task description.
   *
   * @param taskDescription - Natural-language description of the current task
   * @param maxInsights - Maximum number of insights to return (default 5)
   * @returns Array of human-readable insight strings
   */
  async getInsightsForTask(taskDescription: string, maxInsights: number = 5): Promise<string[]> {
    // 1. Check if there are any active/proposed instincts worth querying
    const activeInstincts = this.storage.getInstincts({ minConfidence: 0.5 });

    if (activeInstincts.length === 0) {
      return [];
    }

    // 2. Find similar instincts using the pattern matcher
    const matches = this.matcher.findSimilarInstincts(taskDescription, {
      minSimilarity: 0.4,
      maxResults: maxInsights,
    });

    // 3. Format each match, filter out failures
    const insights: string[] = [];

    for (const match of matches) {
      const formatted = this.formatInsight(match);
      if (formatted !== null) {
        insights.push(formatted);
      }
    }

    return insights;
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
