/**
 * ChainDetector -- Contiguous sequence mining from trajectory data
 *
 * Scans stored trajectories for recurring tool sequences that meet
 * configurable thresholds for frequency and success rate.
 *
 * Detection algorithm:
 * 1. Fetch recent trajectories from storage (within maxAgeDays)
 * 2. Extract all contiguous tool subsequences of valid lengths
 * 3. Count occurrences per-trajectory (deduplicated within each trajectory)
 * 4. Filter by minOccurrences and successRateThreshold
 * 5. Remove shorter chains subsumed by longer ones (longest-match-wins)
 * 6. Sort by occurrences descending
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type { TrajectoryStep } from "../types.js";
import type { ToolChainConfig, CandidateChain } from "./chain-types.js";

/** Mutable internal variant used during detection accumulation */
interface MutableCandidate {
  toolNames: string[];
  occurrences: number;
  successCount: number;
  sampleSteps: TrajectoryStep[][];
  key: string;
}

export class ChainDetector {
  constructor(
    private readonly learningStorage: LearningStorage,
    private readonly config: ToolChainConfig,
  ) {}

  /**
   * Scan trajectories for recurring contiguous tool sequences.
   * Returns candidates meeting minOccurrences and successRateThreshold.
   */
  detect(): CandidateChain[] {
    // 1. Fetch trajectories from storage (within age limit)
    const since = Date.now() - this.config.maxAgeDays * 24 * 60 * 60 * 1000;
    const trajectories = this.learningStorage.getTrajectories({ since });

    // 2. Build frequency map: Map<key, MutableCandidate>
    const candidates = new Map<string, MutableCandidate>();

    for (const trajectory of trajectories) {
      // Extract tool name sequence from steps
      const toolNames = trajectory.steps.map((s) => s.toolName);
      if (toolNames.length < this.config.minChainLength) continue;

      // Track which sequences appear in THIS trajectory (per-trajectory counting)
      const seenInTrajectory = new Set<string>();

      // Generate all contiguous subsequences of valid lengths
      for (
        let len = this.config.minChainLength;
        len <= Math.min(this.config.maxChainLength, toolNames.length);
        len++
      ) {
        for (let start = 0; start <= toolNames.length - len; start++) {
          const subseq = toolNames.slice(start, start + len);
          const key = subseq.join(",");

          if (seenInTrajectory.has(key)) continue;
          seenInTrajectory.add(key);

          if (!candidates.has(key)) {
            candidates.set(key, {
              toolNames: subseq,
              occurrences: 0,
              successCount: 0,
              sampleSteps: [],
              key,
            });
          }

          const candidate = candidates.get(key)!;
          candidate.occurrences++;
          if (trajectory.outcome.success) {
            candidate.successCount++;
          }
          // Keep up to 3 sample step arrays for LLM context
          if (candidate.sampleSteps.length < 3) {
            candidate.sampleSteps.push(
              trajectory.steps.slice(start, start + len),
            );
          }
        }
      }
    }

    // 3. Filter by thresholds
    let results = Array.from(candidates.values()).filter((c) => {
      const successRate =
        c.occurrences > 0 ? c.successCount / c.occurrences : 0;
      return (
        c.occurrences >= this.config.minOccurrences &&
        successRate >= this.config.successRateThreshold
      );
    });

    // 4. Longest-match-wins: remove shorter sequences subsumed by longer ones
    results = this.removeSubsumedChains(results);

    // 5. Sort by occurrences descending
    results.sort((a, b) => b.occurrences - a.occurrences);

    return results;
  }

  /**
   * Remove shorter chains that are subsumed by longer chains with >= occurrences.
   * A shorter chain is subsumed if a longer chain's key contains the shorter key
   * and the longer chain has at least as many occurrences.
   */
  private removeSubsumedChains(
    chains: MutableCandidate[],
  ): MutableCandidate[] {
    return chains.filter((chain) => {
      // A chain at maxChainLength cannot be subsumed
      if (chain.toolNames.length === this.config.maxChainLength) return true;

      // Check if any longer chain subsumes this one
      const chainKey = chain.key;
      return !chains.some(
        (longer) =>
          longer.key !== chainKey &&
          longer.toolNames.length > chain.toolNames.length &&
          longer.key.includes(chainKey) &&
          longer.occurrences >= chain.occurrences,
      );
    });
  }
}
