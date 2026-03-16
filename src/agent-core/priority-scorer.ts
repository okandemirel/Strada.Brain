/**
 * Priority Scorer
 *
 * Adjusts observation priority based on learned patterns.
 * Connects the learning system to observation ranking.
 */

import type { AgentObservation } from "./observation-types.js";

/** Structural interface for InstinctRetriever */
interface InstinctRetrieverRef {
  getInsightsForTask(taskDescription: string): Promise<{ insights: string[]; matchedInstinctIds: string[] }>;
}

export class PriorityScorer {
  private readonly recentActionHashes = new Map<string, number>(); // hash -> timestamp
  private static readonly RECENT_ACTION_WINDOW_MS = 300_000; // 5 min

  constructor(private readonly instinctRetriever?: InstinctRetrieverRef) {}

  /**
   * Score and adjust priorities for a batch of observations.
   * Returns sorted (highest priority first) with adjusted scores.
   */
  async scoreAll(observations: AgentObservation[]): Promise<AgentObservation[]> {
    const scored: AgentObservation[] = [];

    for (const obs of observations) {
      let priority = obs.priority;

      // Boost if we have learned patterns for this type of observation
      if (this.instinctRetriever) {
        try {
          const insights = await this.instinctRetriever.getInsightsForTask(obs.summary);
          if (insights.insights.length > 0) {
            priority += 15; // We have experience with this
          }
        } catch {
          // Non-fatal
        }
      }

      // Penalty for recently acted-on similar observations (dedup at reasoning level)
      const hash = `${obs.source}:${obs.summary.slice(0, 60)}`;
      const lastActed = this.recentActionHashes.get(hash);
      if (lastActed && Date.now() - lastActed < PriorityScorer.RECENT_ACTION_WINDOW_MS) {
        priority -= 30; // Already handled recently
      }

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

    // Prune old entries
    const now = Date.now();
    for (const [h, ts] of this.recentActionHashes) {
      if (now - ts > PriorityScorer.RECENT_ACTION_WINDOW_MS) {
        this.recentActionHashes.delete(h);
      }
    }
  }
}
