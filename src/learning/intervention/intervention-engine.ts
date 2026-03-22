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

interface TrustContext {
  approvals: number;
  rejections: number;
  totalUses: number;
  confidence: number;
  lifecycle: string;
  overridden: boolean;
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
    params: Record<string, unknown>,
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
   * State machine for advancing an instinct's trust level.
   *
   * Transitions:
   *   new          → suggest_only : first approval (approvals >= 1)
   *   suggest_only → warn_enabled : 3+ approvals, 0 rejections in last 10 uses
   *   warn_enabled → auto_enabled : 10+ approvals, confidence > 0.8,
   *                                 lifecycle = permanent, never overridden
   */
  advanceTrust(current: TrustLevel, ctx: TrustContext): TrustLevel {
    switch (current) {
      case 'new': {
        if (ctx.approvals >= 1) return 'suggest_only';
        return 'new';
      }

      case 'suggest_only': {
        if (ctx.approvals >= 3 && ctx.rejections === 0) return 'warn_enabled';
        return 'suggest_only';
      }

      case 'warn_enabled': {
        if (
          ctx.approvals >= 10 &&
          ctx.confidence > 0.8 &&
          ctx.lifecycle === 'permanent' &&
          !ctx.overridden
        ) {
          return 'auto_enabled';
        }
        return 'warn_enabled';
      }

      case 'auto_enabled': {
        return 'auto_enabled';
      }
    }
  }

  /**
   * Persist an intervention log entry to storage.
   */
  async logIntervention(
    instinctId: string,
    toolName: string,
    tier: string,
    actionTaken: 'applied' | 'overridden' | 'dismissed',
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
