/**
 * Intervention Types
 *
 * Type definitions, helper functions, and tier/lifecycle validation logic
 * for the Learning Pipeline v2 Intervention Engine.
 */

import type { InterventionTier, TrustLevel } from '../types.js';

// =============================================================================
// RESULT TYPES
// =============================================================================

/** Action that the engine decided to take for a given instinct */
export type InterventionAction = 'auto_apply' | 'warn' | 'suggest' | 'enrich' | 'none';

/** A single instinct's evaluated intervention match */
export interface InterventionMatch {
  /** ID of the evaluated instinct */
  instinctId: string;
  /** Tier assigned to this instinct after all caps/lifecycle rules */
  tier: InterventionTier;
  /** Action that this tier maps to */
  action: InterventionAction;
  /** Reason for this tier assignment (for debugging/logging) */
  reason: string;
}

/** Result returned by InterventionEngine.evaluate() */
export interface InterventionResult {
  /** Highest-priority action across all matched instincts */
  action: InterventionAction;
  /** All per-instinct matches (including filtered-out ones) */
  matches: InterventionMatch[];
  /** Tool name evaluated */
  toolName: string;
}

// =============================================================================
// TIER HELPERS
// =============================================================================

/** Tier priority order (higher index = higher priority) */
const TIER_PRIORITY: InterventionTier[] = ['passive', 'suggest', 'warn', 'auto'];

/**
 * Map a confidence score to a base intervention tier.
 * > 0.8  → 'auto'
 * >= 0.6 → 'warn'
 * >= 0.3 → 'suggest'
 * < 0.3  → 'passive'
 */
export function getInterventionTier(confidence: number): InterventionTier {
  if (confidence > 0.8) return 'auto';
  if (confidence >= 0.6) return 'warn';
  if (confidence >= 0.3) return 'suggest';
  return 'passive';
}

/**
 * Return the lower of two tiers (i.e. apply a cap).
 */
export function capTier(tier: InterventionTier, cap: InterventionTier): InterventionTier {
  const tierIdx = TIER_PRIORITY.indexOf(tier);
  const capIdx = TIER_PRIORITY.indexOf(cap);
  return tierIdx <= capIdx ? tier : cap;
}

/**
 * Return the tier that corresponds to an action string.
 */
export function tierFromAction(action: InterventionAction): InterventionTier | null {
  switch (action) {
    case 'auto_apply': return 'auto';
    case 'warn': return 'warn';
    case 'suggest': return 'suggest';
    case 'enrich': return 'passive';
    default: return null;
  }
}

/**
 * Map a tier to its canonical action.
 */
export function actionFromTier(tier: InterventionTier): InterventionAction {
  switch (tier) {
    case 'auto': return 'auto_apply';
    case 'warn': return 'warn';
    case 'suggest': return 'suggest';
    case 'passive': return 'enrich';
  }
}

// =============================================================================
// LIFECYCLE VALIDATION
// =============================================================================

/**
 * Determine the maximum allowed tier for a given instinct lifecycle status.
 *
 * - proposed  → passive only
 * - active    → max warn  (no auto)
 * - permanent → all tiers valid
 * - deprecated / evolved → no valid tier (instinct should be skipped)
 */
export function maxTierForLifecycle(lifecycle: string): InterventionTier | null {
  switch (lifecycle) {
    case 'proposed': return 'passive';
    case 'active': return 'warn';
    case 'permanent': return 'auto';
    default: return null; // deprecated / evolved → skip
  }
}

/**
 * Returns true if the tier is valid for the given instinct lifecycle.
 */
export function isTierValidForLifecycle(tier: InterventionTier, lifecycle: string): boolean {
  const max = maxTierForLifecycle(lifecycle);
  if (max === null) return false;
  return TIER_PRIORITY.indexOf(tier) <= TIER_PRIORITY.indexOf(max);
}

// =============================================================================
// TRUST LEVEL VALIDATION
// =============================================================================

/**
 * Determine the maximum allowed tier for a given trust level.
 *
 * - new          → passive only
 * - suggest_only → max suggest
 * - warn_enabled → max warn
 * - auto_enabled → all tiers
 */
export function maxTierForTrust(trust: TrustLevel): InterventionTier {
  switch (trust) {
    case 'new': return 'passive';
    case 'suggest_only': return 'suggest';
    case 'warn_enabled': return 'warn';
    case 'auto_enabled': return 'auto';
  }
}

/**
 * Returns true if the tier is valid for the given trust level.
 */
export function isTrustLevelValidForLifecycle(tier: InterventionTier, trust: TrustLevel): boolean {
  const max = maxTierForTrust(trust);
  return TIER_PRIORITY.indexOf(tier) <= TIER_PRIORITY.indexOf(max);
}

/**
 * Return the highest-priority action from a list of matches.
 * Priority: auto_apply > warn > suggest > enrich > none
 */
export function highestPriorityAction(matches: InterventionMatch[]): InterventionAction {
  const actionPriority: InterventionAction[] = ['none', 'enrich', 'suggest', 'warn', 'auto_apply'];
  let best: InterventionAction = 'none';
  for (const m of matches) {
    if (actionPriority.indexOf(m.action) > actionPriority.indexOf(best)) {
      best = m.action;
    }
  }
  return best;
}
