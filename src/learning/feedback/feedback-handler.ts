/**
 * Feedback Handler
 *
 * Processes thumbs up/down, teaching, and correction feedback
 * to update instinct confidence factors and store feedback records.
 */

import { randomBytes } from "node:crypto";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { FeedbackSource, FeedbackType, ScopeType, CorrectionRecord, Instinct } from "../types.js";

/**
 * Called once per reacted-to instinct, after the factor column moved, with the
 * freshly re-read instinct. The LearningPipeline uses it to push the reaction
 * into the stored confidence and run the lifecycle state machine.
 *
 * audited 2026-09-02: without this hook a reaction only moved
 * factor_user_validation, a column no decision reads.
 */
export type ReactionEvidenceHook = (instinct: Instinct, positive: boolean) => void;

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

  constructor(storage: LearningStorage, options?: { onReaction?: ReactionEvidenceHook }) {
    this.storage = storage;
    this.onReaction = options?.onReaction;
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
    feedbackType: FeedbackType,
  ): void {
    for (const instinctId of params.instinctIds) {
      const instinct = this.storage.getInstinct(instinctId);
      if (!instinct) continue;

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
