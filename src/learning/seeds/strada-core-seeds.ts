/**
 * Strada.Core Seed Knowledge
 *
 * Seeds the learning pipeline with Strada.Core framework conventions at boot.
 * These provide an initial baseline of instincts so the agent can guide users
 * toward correct Strada.Core patterns from the very first interaction.
 */

import { randomBytes } from "node:crypto";
import type { LearningStorage } from "../storage/learning-storage.js";
import type {
  ScopeType,
  TrustLevel,
  InstinctStats,
  InstinctId,
} from "../types.js";
import type { NormalizedScore, TimestampMs } from "../../types/index.js";

// =============================================================================
// SEED INSTINCT TYPE
// =============================================================================

/** Lightweight descriptor used to define seed instincts before storage */
export interface SeedInstinct {
  /** Trigger pattern used to match this convention */
  readonly pattern: string;
  /** Action descriptor (description field for the learned action) */
  readonly action: { readonly description: string };
  /** Scope for this instinct */
  readonly scope: ScopeType;
  /** Initial confidence score */
  readonly confidence: number;
  /** Initial trust level */
  readonly trustLevel: TrustLevel;
  /** Whether this is a seed instinct */
  readonly seed: true;
}

// =============================================================================
// SEED DATA
// =============================================================================

/** Five foundational Strada.Core convention instincts seeded at boot */
export const STRADA_SEEDS: SeedInstinct[] = [
  {
    pattern: "dependency_injection",
    action: { description: "Use Strada.Core DI container, not Zenject/VContainer" },
    scope: "global",
    confidence: 0.65,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "mediator_pattern",
    action: { description: "Use Strada.Core MediatR implementation" },
    scope: "global",
    confidence: 0.65,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "async_pattern",
    action: { description: "Use UniTask for async operations, not System.Threading.Tasks" },
    scope: "global",
    confidence: 0.65,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "event_system",
    action: { description: "Use Strada.Core EventBus for decoupled communication" },
    scope: "global",
    confidence: 0.65,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "object_pooling",
    action: { description: "Use Strada.Core ObjectPool for frequently instantiated objects" },
    scope: "global",
    confidence: 0.65,
    trustLevel: "warn_enabled",
    seed: true,
  },
];

// =============================================================================
// SEED FUNCTION
// =============================================================================

const EMPTY_STATS: InstinctStats = {
  timesSuggested: 0,
  timesApplied: 0,
  timesFailed: 0,
  successRate: 0 as NormalizedScore,
  averageExecutionMs: 0,
};

/**
 * Seeds Strada.Core conventions into storage if they don't already exist.
 * Idempotent — skips any pattern that is already present at global scope.
 */
export async function seedStradaConventions(storage: LearningStorage): Promise<void> {
  for (const seed of STRADA_SEEDS) {
    // Dedup: skip if a global-scoped instinct with this pattern already exists
    const existing = storage.getInstinctByPattern(seed.pattern, "global");
    if (existing) continue;

    const id = `seed_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const now = Date.now();

    storage.createInstinct({
      id: id as InstinctId,
      name: seed.pattern.replace(/_/g, " "),
      type: "seed",
      status: "active",
      confidence: seed.confidence as NormalizedScore,
      triggerPattern: seed.pattern,
      action: seed.action.description,
      contextConditions: [],
      stats: EMPTY_STATS,
      createdAt: now as TimestampMs,
      updatedAt: now as TimestampMs,
      sourceTrajectoryIds: [],
      tags: ["seed", "strada-core"],
      trustLevel: seed.trustLevel,
      seed: true,
      scopeType: seed.scope,
    });

    // Register the global scope so getInstinctByPattern('pattern', 'global') finds it
    storage.addInstinctScopeV2(id, "", "global");
  }
}
