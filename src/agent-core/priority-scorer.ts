/**
 * Priority Scorer
 *
 * Multi-factor priority scoring for agent observations.
 * Factors: instinct match count, source severity, graduated recency penalty, actionability.
 */

import type { AgentObservation, ObservationSource } from "./observation-types.js";
import type { InstinctRetrieverRef } from "./agent-core-types.js";

/** Base importance boost by observation source */
const SOURCE_SEVERITY: Partial<Record<ObservationSource, number>> = {
  build: 10,
  test: 8,
  "task-outcome": 5,
  user: 5,
};

export class PriorityScorer {
  private readonly recentActionHashes = new Map<string, number>(); // hash -> timestamp
  private static readonly RECENT_ACTION_WINDOW_MS = 300_000; // 5 min

  constructor(private readonly instinctRetriever?: InstinctRetrieverRef) {}

  /**
   * Score and adjust priorities for a batch of observations.
   * Uses multi-factor model: instinct confidence, source severity,
   * graduated recency penalty, and actionability boost.
   * Returns sorted (highest priority first) with adjusted scores.
   */
  async scoreAll(observations: AgentObservation[]): Promise<AgentObservation[]> {
    const scored: AgentObservation[] = [];
    const now = Date.now();
    this.pruneOldActions(now);

    for (const obs of observations) {
      let priority = obs.priority;

      // Factor 1: Instinct match weight (scaled by match count)
      if (this.instinctRetriever) {
        try {
          const result = await this.instinctRetriever.getInsightsForTask(obs.summary);
          const matchCount = result.insights.length;
          if (matchCount >= 3) priority += 15;
          else if (matchCount >= 2) priority += 12;
          else if (matchCount >= 1) priority += 8;
        } catch {
          // Non-fatal
        }
      }

      // Factor 2: Source severity
      priority += SOURCE_SEVERITY[obs.source] ?? 0;

      // Factor 3: Graduated recency penalty
      const hash = `${obs.source}:${obs.summary.slice(0, 60)}`;
      const lastActed = this.recentActionHashes.get(hash);
      if (lastActed) {
        const elapsed = now - lastActed;
        if (elapsed < 60_000) priority -= 30;
        else if (elapsed < 180_000) priority -= 20;
        else if (elapsed < PriorityScorer.RECENT_ACTION_WINDOW_MS) priority -= 10;
      }

      // Factor 4: Actionability boost
      if (obs.actionable && priority > 50) priority += 5;

      scored.push({ ...obs, priority: Math.min(100, Math.max(0, priority)) });
    }

    // Sort descending
    scored.sort((a, b) => b.priority - a.priority);
    return scored;
  }

  /** Record that an observation was acted upon (for dedup) */
  recordAction(observation: AgentObservation): void {
    const hash = `${observation.source}:${observation.summary.slice(0, 60)}`;
    this.recentActionHashes.set(hash, Date.now());
    this.pruneOldActions(Date.now());
  }

  /** Remove entries older than the recency window */
  private pruneOldActions(now: number): void {
    for (const [h, ts] of this.recentActionHashes) {
      if (now - ts > PriorityScorer.RECENT_ACTION_WINDOW_MS) {
        this.recentActionHashes.delete(h);
      }
    }
  }
}
