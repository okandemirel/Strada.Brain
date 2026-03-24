/**
 * Shared Seed Utilities
 *
 * Common logic for seeding instincts into the learning pipeline.
 * Used by strada-core-seeds, strada-modules-seeds, and strada-mcp-seeds.
 */

import { randomBytes } from "node:crypto";
import type { LearningStorage } from "../storage/learning-storage.js";
import type { InstinctStats, InstinctId } from "../types.js";
import type { NormalizedScore, TimestampMs } from "../../types/index.js";
import type { SeedInstinct } from "./strada-core-seeds.js";

const EMPTY_STATS: InstinctStats = {
  timesSuggested: 0,
  timesApplied: 0,
  timesFailed: 0,
  successRate: 0 as NormalizedScore,
  averageExecutionMs: 0,
};

/**
 * Seed instincts into storage. Idempotent — skips any pattern already present.
 */
export async function seedInstincts(
  storage: LearningStorage,
  seeds: SeedInstinct[],
  tag: string,
): Promise<void> {
  for (const seed of seeds) {
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
      tags: ["seed", tag],
      trustLevel: seed.trustLevel,
      seed: true,
      scopeType: seed.scope,
    });

    storage.addInstinctScopeV2(id, "", "global");
  }
}
