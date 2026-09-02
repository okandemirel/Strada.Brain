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
  /**
   * Receives every recordOutcome() so the outcome reaches the stored
   * confidence (LearningPipeline.recordInstinctOutcomeEvidence). Without it
   * recordOutcome only moves factor_consistency, which nothing reads.
   * (audited 2026-09-02)
   */
  readonly onOutcome?: (instinctId: string, success: boolean) => void;
}

/** Result from getInsightsForTask containing both formatted strings and raw IDs */
export interface InsightResult {
  /** Formatted human-readable insight strings */
  readonly insights: string[];
  /** Raw instinct IDs for metrics storage (EVAL-03 pattern reuse tracking) */
  readonly matchedInstinctIds: string[];
}

/**
 * Ranked matches plus the counts the retrieval metric row is built from, so the
 * row names what it measured instead of carrying a hard-coded 0.
 */
interface RankedMatches {
  /** The matches that survived ranking, capped at maxResults. */
  readonly matches: PatternMatch[];
  /** Candidates the matcher handed to ranking, before any of it dropped them. */
  readonly candidatesScanned: number;
  /** Candidates dropped because a higher-or-equal-scope duplicate of the same trigger pattern won. */
  readonly scopeFiltered: number;
}

export class InstinctRetriever {
  private readonly scopeContext?: ScopeContext;
  private readonly storage?: LearningStorage;
  private readonly metricsRecorder?: MetricsRecorder;
  private readonly onOutcome?: (instinctId: string, success: boolean) => void;

  constructor(
    private readonly matcher: PatternMatcher,
    options?: InstinctRetrieverOptions,
  ) {
    this.scopeContext = options?.scopeContext;
    this.storage = options?.storage;
    this.metricsRecorder = options?.metricsRecorder;
    this.onOutcome = options?.onOutcome;
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

    const ranked = await this.findAndRankMatches(taskDescription, maxInsights);
    const finalMatches = ranked.matches;

    const insights: string[] = [];
    const matchedInstinctIds: string[] = [];

    for (const match of finalMatches) {
      // audited 2026-09-02: the id used to be pushed BEFORE formatting, so an
      // instinct whose insight was dropped still landed in
      // currentSessionInstinctIds and was credited (timesApplied, confidence)
      // for a run in which the model never saw it. Credit only what was
      // actually rendered, and keep ids index-aligned with insights — the
      // memory-refresher zips the two arrays positionally.
      const formatted = this.formatInsight(match);
      if (formatted === null) continue;
      insights.push(formatted);

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
    }

    // Record retrieval metrics if recorder available
    if (this.metricsRecorder) {
      try {
        // audited 2026-09-02: scopeFiltered was the literal 0 — every row
        // claimed the scope filter dropped nothing, whatever it dropped — and
        // instinctsScanned counted the SURVIVORS, so scanned/filtered/returned
        // could not be read as one row. Both now name what they measured:
        // scanned = candidates the matcher handed to ranking, scopeFiltered =
        // those ranking discarded because a same-trigger-pattern candidate of
        // higher-or-equal scope priority won.
        this.metricsRecorder.recordRetrievalMetrics({
          retrievalTimeMs: Date.now() - retrievalStart,
          instinctsScanned: ranked.candidatesScanned,
          scopeFiltered: ranked.scopeFiltered,
          insightsReturned: insights.length,
        });
      } catch {
        // Non-blocking: metrics failure must not affect retrieval
      }
    }

    return { insights, matchedInstinctIds };
  }

  /**
   * Record whether an instinct-informed decision succeeded or failed.
   * Updates the instinct's factorConsistency using an asymmetric delta:
   *   success → +0.05, failure → -0.10 (P2 action→outcome feedback loop),
   * then hands the outcome to onOutcome so it reaches the stored confidence.
   * audited 2026-09-02: before the hook the factor column was the only thing
   * that moved, and no ranking or lifecycle decision reads it.
   */
  async recordOutcome(instinctId: string, success: boolean): Promise<void> {
    if (!this.storage) return;
    const instinct = this.storage.getInstinct(instinctId);
    if (!instinct || instinct.status === "permanent") return;

    const delta = success ? 0.05 : -0.10;
    this.storage.updateInstinctFactor(instinctId, "factor_consistency", delta);
    // After the factor write, so the pipeline's re-read carries the moved column.
    this.onOutcome?.(instinctId, success);
  }

  async getMatchedInstincts(taskDescription: string, maxInstincts: number = 5): Promise<Instinct[]> {
    const { matches } = await this.findAndRankMatches(taskDescription, maxInstincts);

    return matches
      .map(m => m.instinct)
      .filter((inst): inst is Instinct => inst !== undefined);
  }

  private async findAndRankMatches(
    taskDescription: string,
    maxResults: number,
  ): Promise<RankedMatches> {
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

  private filterDedupAndBoost(matches: PatternMatch[], maxResults: number): RankedMatches {
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
    return {
      matches: boosted.slice(0, maxResults),
      candidatesScanned: matches.length,
      // Exactly the candidates the scope-priority dedup above discarded: a
      // deprecated drop or the maxResults cap is NOT a scope filter and must
      // not be reported as one (audited 2026-09-02).
      scopeFiltered: filtered.length - byPattern.size,
    };
  }

  private formatInsight(match: PatternMatch): string | null {
    if (!match.instinct?.action) return null;

    // audited 2026-09-02: only the workflow_pattern writers JSON-encode
    // `action`; seeds, teachExplicit, recordCorrection and
    // recordAutoResolution store plain prose. This used to `return null` on
    // parse failure, silently discarding 70% of the live instinct store
    // (every seed, teaching and correction) before it reached the prompt.
    // Prose is the instinct's own description, not a malformed record.
    let action: { description?: string; tool?: string; output?: string };
    const raw = match.instinct.action;
    if (typeof raw !== 'string') {
      action = raw;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      action = parsed !== null && typeof parsed === 'object'
        ? (parsed as typeof action)
        : { description: raw.trim() };
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
