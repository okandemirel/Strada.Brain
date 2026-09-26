/**
 * Intervention Engine
 *
 * Evaluates instincts before tool calls and determines what intervention
 * tier to apply, respecting lifecycle rules and progressive trust levels.
 */

import { randomBytes } from 'node:crypto';
import type { Instinct, InterventionTier, TrustLevel } from '../types.js';
import type { InterventionResult, InterventionMatch } from './intervention-types.js';
import {
  getInterventionTier,
  maxTierForLifecycle,
  capTier,
  actionFromTier,
  highestPriorityAction,
  maxTierForTrust,
} from './intervention-types.js';
import type { LearningStorage } from '../storage/learning-storage.js';

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/** How many of an instinct's latest judged uses its trust is decided on. */
export const TRUST_SIGNAL_WINDOW = 10;

/**
 * Explicit human signals about one learned instinct, counted over its last
 * {@link TRUST_SIGNAL_WINDOW} judged uses (the signal being applied included).
 */
export interface TrustContext {
  approvals: number;
  rejections: number;
  /** The signal being applied now. A rejection demotes one step. */
  signal: 'approval' | 'rejection';
}

// =============================================================================
// INTERVENTION ENGINE
// =============================================================================

export class InterventionEngine {
  constructor(private readonly storage: LearningStorage) {}

  /**
   * Evaluate a tool call against a set of relevant instincts.
   * Returns the highest-priority intervention action and per-instinct details.
   */
  evaluate(
    toolName: string,
    _params: Record<string, unknown>,
    relevantInstincts: Instinct[],
  ): InterventionResult {
    const matches: InterventionMatch[] = [];

    for (const instinct of relevantInstincts) {
      // Step 1: Skip deprecated / evolved instincts
      if (instinct.status === 'deprecated' || instinct.status === 'evolved') {
        continue;
      }

      // Step 2: Determine the max tier the lifecycle allows
      const lifecycleMax = maxTierForLifecycle(instinct.status);
      if (lifecycleMax === null) {
        // Should not happen after the guard above, but be safe
        continue;
      }

      // Step 3: Get base tier from confidence
      let tier: InterventionTier = getInterventionTier(instinct.confidence);

      // Step 4: Cap by lifecycle
      tier = capTier(tier, lifecycleMax);

      // Step 5: Cap by trust level
      const trustLevel: TrustLevel = instinct.trustLevel ?? 'new';
      const trustMax = maxTierForTrust(trustLevel);
      tier = capTier(tier, trustMax);

      const action = actionFromTier(tier);

      matches.push({
        instinctId: instinct.id,
        tier,
        action,
        reason: `lifecycle=${instinct.status} trustLevel=${trustLevel} confidence=${instinct.confidence}`,
      });
    }

    const action = matches.length > 0 ? highestPriorityAction(matches) : 'none';

    return { action, matches, toolName };
  }

  /**
   * The trust ladder for LEARNED instincts (LRN-20).
   *
   *   new          → suggest_only : an approval (approvals >= 1)
   *   suggest_only → warn_enabled : 3+ approvals and 0 rejections in the last
   *                                 {@link TRUST_SIGNAL_WINDOW} judged uses
   *   warn_enabled                : the ceiling
   *   a rejection                 : one step down (warn_enabled → suggest_only,
   *                                 suggest_only → new)
   *
   * Called by the learning pipeline (`LearningPipeline.recordHumanTrustSignal`)
   * for explicit HUMAN signals only: a person's reaction on a run that applied
   * the instinct. The agent's own tool successes, run verdicts and confidence
   * gains never reach it, because a loop must not promote a rule it wrote
   * itself. The warn tier is advisory: its text is appended to the tool result
   * after the tool ran, nothing is blocked or rewritten.
   *
   * Never returns 'auto_enabled': a learned instinct is capped at warn_enabled
   * (one that somehow carries auto_enabled is treated as warn_enabled). Only
   * seeded / curated rules carry auto_enabled, and the pipeline does not run
   * this ladder for them.
   */
  advanceTrust(current: TrustLevel, ctx: TrustContext): TrustLevel {
    const from: TrustLevel = current === 'auto_enabled' ? 'warn_enabled' : current;
    if (ctx.signal === 'rejection') {
      return from === 'warn_enabled' ? 'suggest_only' : 'new';
    }
    switch (from) {
      case 'new':
        return ctx.approvals >= 1 ? 'suggest_only' : 'new';
      case 'suggest_only':
        return ctx.approvals >= 3 && ctx.rejections === 0 ? 'warn_enabled' : 'suggest_only';
      default:
        return 'warn_enabled';
    }
  }

  /**
   * Persist an intervention log entry to storage.
   */
  async logIntervention(
    instinctId: string,
    toolName: string,
    tier: string,
    // 'accepted' / 'dismissed': the requester's verdict on a response whose
    // footer showed this warning (LRN-20b); 'applied' is logged when it fires.
    actionTaken: 'applied' | 'overridden' | 'dismissed' | 'accepted',
    userId?: string,
  ): Promise<void> {
    const id = randomBytes(8).toString('hex');
    this.storage.logIntervention({
      id,
      instinctId,
      toolName,
      tier,
      actionTaken,
      userId,
      createdAt: Date.now(),
    });
  }
}
