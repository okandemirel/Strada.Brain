/**
 * ChainValidator -- Post-synthesis validation and runtime feedback for composite tools
 *
 * INTEL-05: validatePostSynthesis() replays historical trajectories against a chain's
 *           tool sequence, updating instinct confidence via ConfidenceScorer.
 * INTEL-06: handleChainExecuted() subscribes to chain:executed events to update
 *           instinct confidence with auto-deprecation when confidence drops below 0.3.
 *
 * Deprecation cascade: when confidence falls below DEPRECATED threshold, the chain
 * is unregistered via onChainDeprecated callback and chain:invalidated is emitted.
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type { ConfidenceScorer } from "../scoring/confidence-scorer.js";
import type {
  IEventEmitter,
  LearningEventMap,
  ChainExecutionEvent,
} from "../../core/event-bus.js";
import type { Instinct, Trajectory } from "../types.js";
import { CONFIDENCE_THRESHOLDS } from "../types.js";
import { isContiguousSubsequence } from "./chain-types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface ChainValidatorDeps {
  readonly storage: LearningStorage;
  readonly confidenceScorer: ConfidenceScorer;
  readonly eventBus: IEventEmitter<LearningEventMap>;
  readonly updateInstinctStatus: (instinct: Instinct) => void;
  readonly onChainDeprecated: (chainName: string) => void;
  readonly maxAgeDays: number;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class ChainValidator {
  private readonly storage: LearningStorage;
  private readonly confidenceScorer: ConfidenceScorer;
  private readonly eventBus: IEventEmitter<LearningEventMap>;
  private readonly updateInstinctStatus: (instinct: Instinct) => void;
  private readonly onChainDeprecated: (chainName: string) => void;
  private readonly maxAgeDays: number;

  constructor(deps: ChainValidatorDeps) {
    this.storage = deps.storage;
    this.confidenceScorer = deps.confidenceScorer;
    this.eventBus = deps.eventBus;
    this.updateInstinctStatus = deps.updateInstinctStatus;
    this.onChainDeprecated = deps.onChainDeprecated;
    this.maxAgeDays = deps.maxAgeDays;
  }

  // ===========================================================================
  // INTEL-05: Post-Synthesis Validation
  // ===========================================================================

  /**
   * Validate a newly synthesized chain against historical trajectory data.
   * Replays matching trajectories and updates instinct confidence accordingly.
   */
  validatePostSynthesis(
    chainName: string,
    toolSequence: string[],
    instinctId: string,
  ): void {
    // Look up the instinct
    const instincts = this.storage.getInstincts({ type: "tool_chain" });
    const instinct = instincts.find((i) => i.id === instinctId);
    if (!instinct) return;

    // Fetch trajectories within maxAgeDays
    const since = Date.now() - this.maxAgeDays * 86_400_000;
    const trajectories = this.storage.getTrajectories({ since, limit: 100 });

    // Filter trajectories containing the tool sequence as a contiguous subsequence
    const matching = this.filterMatchingTrajectories(
      trajectories,
      toolSequence,
    );
    if (matching.length === 0) return;

    // Replay each matching trajectory against confidence
    let currentInstinct = instinct;
    for (const traj of matching) {
      const success = this.isSequenceSuccessful(traj, toolSequence);
      currentInstinct = this.confidenceScorer.updateConfidence(
        currentInstinct,
        success,
      );
      this.storage.updateInstinct(currentInstinct);
    }

    // Check deprecation threshold
    const deprecated =
      currentInstinct.confidence < CONFIDENCE_THRESHOLDS.DEPRECATED;
    if (deprecated) {
      this.handleDeprecation(chainName, currentInstinct);
    }

    // Emit chain:validated event
    this.eventBus.emit("chain:validated", {
      chainName,
      validationCount: matching.length,
      resultingConfidence: currentInstinct.confidence,
      deprecated,
      timestamp: Date.now(),
    });
  }

  // ===========================================================================
  // INTEL-06: Runtime Feedback
  // ===========================================================================

  /**
   * Handle a chain:executed event by updating the corresponding instinct's confidence.
   * Skips permanent and deprecated instincts.
   * Triggers deprecation cascade if instinct becomes deprecated after lifecycle update.
   */
  handleChainExecuted(event: ChainExecutionEvent): void {
    // Look up tool_chain instincts and find one matching the chain name
    const instincts = this.storage.getInstincts({ type: "tool_chain" });
    const instinct = instincts.find((i) => i.name === event.chainName);
    if (!instinct) return;

    // Skip permanent and deprecated instincts
    if (instinct.status === "permanent" || instinct.status === "deprecated") {
      return;
    }

    // Update confidence
    const updated = this.confidenceScorer.updateConfidence(
      instinct,
      event.success,
    );
    this.storage.updateInstinct(updated);

    // Run lifecycle management
    this.updateInstinctStatus(updated);

    // Re-read instinct to check if status changed to deprecated
    const reRead = this.storage.getInstinct(updated.id);
    if (reRead && reRead.status === "deprecated") {
      this.onChainDeprecated(event.chainName);
    }
  }

  // ===========================================================================
  // PRIVATE: Deprecation Cascade
  // ===========================================================================

  /**
   * Handle deprecation: notify chain manager and emit invalidation event.
   */
  private handleDeprecation(chainName: string, _instinct: Instinct): void {
    this.onChainDeprecated(chainName);
    this.eventBus.emit("chain:invalidated", {
      chainName,
      reason: "Bayesian confidence below threshold",
      timestamp: Date.now(),
    });
  }

  // ===========================================================================
  // PRIVATE: Trajectory Matching Helpers
  // ===========================================================================

  /**
   * Filter trajectories whose steps contain the tool sequence as a contiguous subsequence.
   */
  private filterMatchingTrajectories(
    trajectories: Trajectory[],
    toolSequence: string[],
  ): Trajectory[] {
    return trajectories.filter((traj) => {
      const stepTools = traj.steps.map((s) => s.toolName);
      return isContiguousSubsequence(toolSequence, stepTools);
    });
  }

  /**
   * Check if the contiguous subsequence steps within a trajectory all succeeded.
   */
  private isSequenceSuccessful(
    trajectory: Trajectory,
    toolSequence: string[],
  ): boolean {
    const stepTools = trajectory.steps.map((s) => s.toolName);

    // Find the starting index of the contiguous subsequence
    for (let i = 0; i <= stepTools.length - toolSequence.length; i++) {
      let match = true;
      for (let j = 0; j < toolSequence.length; j++) {
        if (stepTools[i + j] !== toolSequence[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        // Check if all matched steps have success result
        for (let j = 0; j < toolSequence.length; j++) {
          if (trajectory.steps[i + j]!.result.kind !== "success") {
            return false;
          }
        }
        return true;
      }
    }
    return false;
  }
}
