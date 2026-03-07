/**
 * ChainDetector -- Contiguous sequence mining from trajectory data
 *
 * Scans stored trajectories for recurring tool sequences that meet
 * configurable thresholds for frequency and success rate.
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type { ToolChainConfig, CandidateChain } from "./chain-types.js";

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
    // Stub -- will be implemented in GREEN phase
    return [];
  }
}
