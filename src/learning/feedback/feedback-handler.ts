/**
 * Feedback Handler
 *
 * Processes thumbs up/down, teaching, and correction feedback
 * to update instinct confidence factors and store feedback records.
 */

import { randomBytes } from "node:crypto";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { FeedbackSource, ScopeType, CorrectionRecord, Instinct } from "../types.js";

/**
 * Called once per reacted-to instinct, after the factor column moved, with the
 * freshly re-read instinct. The LearningPipeline uses it to push the reaction
 * into the stored confidence and run the lifecycle state machine.
 *
 * audited 2026-09-02: without this hook a reaction only moved
 * factor_user_validation, a column no decision reads.
 */
export type ReactionEvidenceHook = (instinct: Instinct, positive: boolean) => void;

/**
 * Called for EVERY attributable reaction (a named person, an existing
 * instinct), before the once-per-person evidence dedup below. The pipeline
 * turns it into a trust signal for the run the instinct was applied in
 * (LRN-20), and dedups per person and run itself.
 */
export type HumanSignalHook = (instinctId: string, userId: string, positive: boolean) => void;

/** Thumbs-up boost amount */
const THUMBS_UP_DELTA = 0.1;

/** Thumbs-down penalty amount */
const THUMBS_DOWN_DELTA = 0.2;

function generateFeedbackId(): string {
  return `fb_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export class FeedbackHandler {
  private storage: LearningStorage;
  private readonly onReaction?: ReactionEvidenceHook;
  private readonly onHumanSignal?: HumanSignalHook;

  constructor(
    storage: LearningStorage,
    options?: { onReaction?: ReactionEvidenceHook; onHumanSignal?: HumanSignalHook },
  ) {
    this.storage = storage;
    this.onReaction = options?.onReaction;
    this.onHumanSignal = options?.onHumanSignal;
  }

  handleThumbsUp(params: {
    instinctIds: string[];
    userId?: string;
    source: FeedbackSource;
  }): void {
    this.applyValidationDelta(params, THUMBS_UP_DELTA, 'thumbs_up');
  }

  handleThumbsDown(params: {
    instinctIds: string[];
    userId?: string;
    source: FeedbackSource;
  }): void {
    this.applyValidationDelta(params, -THUMBS_DOWN_DELTA, 'thumbs_down');
  }

  private applyValidationDelta(
    params: { instinctIds: string[]; userId?: string; source: FeedbackSource },
    delta: number,
    feedbackType: 'thumbs_up' | 'thumbs_down',
  ): void {
    // A reaction is evidence once per person, rule and direction (LRN-10).
    // Every event applied full evidence, so one member toggling an emoji moved
    // every rule the channel had applied, as far as they liked. A reaction
    // nobody can be named for moves nothing. Every event is still recorded.
    const userId = params.userId?.trim();
    for (const instinctId of new Set(params.instinctIds)) {
      const instinct = this.storage.getInstinct(instinctId);
      if (!instinct) continue;
      if (userId) this.onHumanSignal?.(instinctId, userId, delta > 0);
      if (!userId || this.storage.hasReactionFrom(userId, instinctId, feedbackType)) continue;

      this.storage.updateInstinctFactor(instinctId, 'factor_user_validation', delta);

      // Re-read so the hook's later updateInstinct carries the moved factor
      // instead of clobbering it with the pre-reaction snapshot.
      if (this.onReaction) {
        const fresh = this.storage.getInstinct(instinctId) ?? instinct;
        this.onReaction(fresh, delta > 0);
      }
    }

    this.storage.storeFeedback({
      id: generateFeedbackId(),
      type: feedbackType,
      userId: params.userId,
      instinctIds: JSON.stringify(params.instinctIds),
      source: params.source,
      createdAt: Date.now(),
    });
  }

  /**
   * Handle explicit teaching: store a teaching feedback record.
   */
  handleTeaching(params: {
    content: string;
    scopeType: ScopeType;
    userId?: string;
  }): void {
    this.storage.storeFeedback({
      id: generateFeedbackId(),
      type: 'teaching',
      userId: params.userId,
      content: params.content,
      scopeType: params.scopeType,
      source: 'natural_language',
      createdAt: Date.now(),
    });
  }

  /**
   * Handle correction feedback: store a correction feedback record.
   */
  handleCorrection(params: CorrectionRecord): void {
    this.storage.storeFeedback({
      id: generateFeedbackId(),
      type: 'correction',
      userId: params.userId,
      instinctIds: params.instinctIds ? JSON.stringify(params.instinctIds) : undefined,
      content: `original: ${params.original} | corrected: ${params.corrected}`,
      source: params.source,
      createdAt: Date.now(),
    });
  }
}
