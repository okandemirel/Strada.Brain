/**
 * Instinct Retriever
 *
 * Proactively retrieves relevant learning insights for a given task description.
 * Uses PatternMatcher to find similar instincts and formats them as human-readable strings.
 * Returns both formatted insights and raw instinct IDs for metrics recording (EVAL-03).
 *
 * Phase 13 additions: scope context, provenance formatting, cross-session hit tracking.
 */

import type { PatternMatcher, ScopeContext } from "../learning/matching/pattern-matcher.js";
import type { LearningStorage } from "../learning/storage/learning-storage.js";
import type { MetricsRecorder } from "../metrics/metrics-recorder.js";
import type { PatternMatch } from "../learning/types.js";

/** Options for InstinctRetriever constructor */
export interface InstinctRetrieverOptions {
  /** Optional scope context for cross-session scope-filtered retrieval */
  readonly scopeContext?: ScopeContext;
  /** Optional storage reference for cross-session hit count tracking */
  readonly storage?: LearningStorage;
  /** Optional metrics recorder for retrieval performance tracking */
  readonly metricsRecorder?: MetricsRecorder;
}

/** Result from getInsightsForTask containing both formatted strings and raw IDs */
export interface InsightResult {
  /** Formatted human-readable insight strings */
  readonly insights: string[];
  /** Raw instinct IDs for metrics storage (EVAL-03 pattern reuse tracking) */
  readonly matchedInstinctIds: string[];
}

export class InstinctRetriever {
  private readonly scopeContext?: ScopeContext;
  private readonly storage?: LearningStorage;
  private readonly metricsRecorder?: MetricsRecorder;

  constructor(
    private readonly matcher: PatternMatcher,
    options?: InstinctRetrieverOptions,
  ) {
    this.scopeContext = options?.scopeContext;
    this.storage = options?.storage;
    this.metricsRecorder = options?.metricsRecorder;
  }

  /**
   * Retrieve formatted insight strings and matched instinct IDs for a task.
   *
   * @param taskDescription - Natural-language description of the current task
   * @param maxInsights - Maximum number of insights to return (default 5)
   * @returns InsightResult with formatted strings and raw instinct IDs
   */
  async getInsightsForTask(taskDescription: string, maxInsights: number = 5): Promise<InsightResult> {
    const retrievalStart = Date.now();

    // Find similar instincts using the pattern matcher (single scan)
    // Request extra results to account for post-filtering of deprecated instincts
    const findOptions: {
      minSimilarity: number;
      maxResults: number;
      scope?: ScopeContext;
    } = {
      minSimilarity: 0.4,
      maxResults: maxInsights + 10,
    };

    // Pass scope context to findSimilarInstincts when available
    if (this.scopeContext) {
      findOptions.scope = this.scopeContext;
    }

    const matches = this.matcher.findSimilarInstincts(taskDescription, findOptions);
    const instinctsScanned = matches.length;

    // Filter out deprecated instincts (EVAL-05: deprecated excluded from retrieval)
    const filtered = matches.filter(m => !m.instinct || m.instinct.status !== "deprecated");

    // Apply 1.2x ranking boost for permanent instincts (EVAL-06: permanent highlighted)
    const boosted = filtered.map(m =>
      m.instinct?.status === "permanent"
        ? { ...m, confidence: m.confidence * 1.2 }
        : m
    );

    // Re-sort by boosted confidence descending
    boosted.sort((a, b) => b.confidence - a.confidence);

    // Limit to maxInsights after filtering and boosting
    const finalMatches = boosted.slice(0, maxInsights);

    const insights: string[] = [];
    const matchedInstinctIds: string[] = [];

    for (const match of finalMatches) {
      if (match.instinct) {
        matchedInstinctIds.push(match.instinct.id);

        // Increment cross-session hit count for instincts from other sessions
        if (
          this.storage &&
          this.scopeContext?.currentSessionId &&
          match.instinct.originBootCount !== undefined &&
          this.scopeContext.currentBootCount !== undefined &&
          match.instinct.originBootCount !== this.scopeContext.currentBootCount
        ) {
          try {
            this.storage.incrementCrossSessionHitCount(
              match.instinct.id,
              this.scopeContext.currentSessionId,
            );
          } catch {
            // Non-blocking: hit count failure should not affect retrieval
          }
        }
      }
      const formatted = this.formatInsight(match);
      if (formatted !== null) {
        insights.push(formatted);
      }
    }

    // Record retrieval metrics if recorder available
    if (this.metricsRecorder) {
      try {
        this.metricsRecorder.recordRetrievalMetrics({
          retrievalTimeMs: Date.now() - retrievalStart,
          instinctsScanned,
          scopeFiltered: instinctsScanned - finalMatches.length,
          insightsReturned: insights.length,
        });
      } catch {
        // Non-blocking: metrics failure must not affect retrieval
      }
    }

    return { insights, matchedInstinctIds };
  }

  /**
   * Format a pattern match into a human-readable insight string.
   * Includes provenance metadata when available (boot number, age, cross-session hits).
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

      let result = `${action.description} (${confidence}% confidence, ${successRate}% success, applied ${applied}x)`;

      // Append provenance bracket when originBootCount exists
      if (match.instinct.originBootCount !== undefined) {
        const ageDays = Math.floor((Date.now() - match.instinct.createdAt) / 86400000);
        const hitCount = match.instinct.crossSessionHitCount ?? 0;
        result += ` [boot #${match.instinct.originBootCount}, ${ageDays}d ago, used by ${hitCount} sessions]`;
      }

      return result;
    } catch {
      return null;
    }
  }
}
