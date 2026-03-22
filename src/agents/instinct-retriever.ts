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
import { MS_PER_DAY, type Instinct, type PatternMatch } from "../learning/types.js";

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

    const finalMatches = await this.findAndRankMatches(taskDescription, maxInsights);

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
          instinctsScanned: finalMatches.length,
          scopeFiltered: 0,
          insightsReturned: insights.length,
        });
      } catch {
        // Non-blocking: metrics failure must not affect retrieval
      }
    }

    return { insights, matchedInstinctIds };
  }

  async getMatchedInstincts(taskDescription: string, maxInstincts: number = 5): Promise<Instinct[]> {
    const matches = await this.findAndRankMatches(taskDescription, maxInstincts);

    return matches
      .map(m => m.instinct)
      .filter((inst): inst is Instinct => inst !== undefined);
  }

  private async findAndRankMatches(taskDescription: string, maxResults: number): Promise<PatternMatch[]> {
    const findOptions: {
      minSimilarity: number;
      maxResults: number;
      scope?: ScopeContext;
    } = {
      minSimilarity: 0.4,
      maxResults: maxResults + 10,
    };

    if (this.scopeContext) {
      findOptions.scope = this.scopeContext;
    }

    const matches = await this.matcher.findSimilarInstincts(taskDescription, findOptions);
    return this.filterDedupAndBoost(matches, maxResults);
  }

  private filterDedupAndBoost(matches: PatternMatch[], maxResults: number): PatternMatch[] {
    const filtered = matches.filter(m => !m.instinct || m.instinct.status !== "deprecated");

    const scopePriority: Record<string, number> = { user: 3, project: 2, global: 1 };
    const byPattern = new Map<string, PatternMatch>();
    for (const match of filtered) {
      const pattern = match.instinct?.triggerPattern ?? '';
      const existing = byPattern.get(pattern);
      const matchScope = match.instinct?.scopeType ?? 'project';
      const existingScope = existing?.instinct?.scopeType ?? 'project';
      if (!existing || (scopePriority[matchScope] ?? 0) > (scopePriority[existingScope] ?? 0)) {
        byPattern.set(pattern, match);
      }
    }

    const boosted = Array.from(byPattern.values()).map(m =>
      m.instinct?.status === "permanent"
        ? { ...m, confidence: m.confidence * 1.2 }
        : m
    );

    boosted.sort((a, b) => b.confidence - a.confidence);
    return boosted.slice(0, maxResults);
  }

  private formatInsight(match: PatternMatch): string | null {
    if (!match.instinct?.action) return null;

    let action: { description?: string; tool?: string; output?: string };
    try {
      action = typeof match.instinct.action === 'string'
        ? JSON.parse(match.instinct.action)
        : match.instinct.action;
    } catch {
      return null;
    }

    const text = action.description
      ?? ('When using ' + (action.tool ?? 'unknown') + ': '
          + this.summarize(action.output ?? ''));

    const confidence = Math.round((match.confidence ?? 0) * 100);
    const stats = match.instinct?.stats;
    const applied = stats?.timesApplied ?? 1;
    const successRate = Math.round((stats?.timesApplied ? stats.successRate * 100 : 0));

    let insight = text + ' (' + confidence + '% confidence, '
      + successRate + '% success, applied ' + applied + 'x)';

    if (match.instinct?.originBootCount != null) {
      const ageDays = Math.floor(
        (Date.now() - (match.instinct.createdAt ?? Date.now())) / MS_PER_DAY
      );
      const hitCount = match.instinct.crossSessionHitCount ?? 0;
      insight += ' [boot #' + match.instinct.originBootCount
        + ', ' + ageDays + 'd ago, used by ' + hitCount + ' sessions]';
    }

    return insight;
  }

  private summarize(text: string, maxLen = 200): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...';
  }
}
