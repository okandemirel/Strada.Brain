/**
 * Strada.Modules Seed Knowledge
 *
 * Seeds the learning pipeline with Strada.Modules conventions at boot.
 * Only seeded when Strada.Modules is detected as installed.
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type { SeedInstinct } from "./strada-core-seeds.js";
import { seedInstincts } from "./seed-utils.js";

/** Three foundational Strada.Modules convention instincts seeded at boot */
export const STRADA_MODULES_SEEDS: SeedInstinct[] = [
  {
    pattern: "strada_modules_registration",
    action: { description: "Register Strada.Modules features via ModuleConfig.Configure(), not manual wiring" },
    scope: "global",
    confidence: 0.60,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "strada_modules_dependency_order",
    action: { description: "Declare module dependencies explicitly to ensure correct initialization order" },
    scope: "global",
    confidence: 0.60,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "strada_modules_isolation",
    action: { description: "Keep modules self-contained; cross-module communication via EventBus, not direct references" },
    scope: "global",
    confidence: 0.60,
    trustLevel: "warn_enabled",
    seed: true,
  },
];

/**
 * Seeds Strada.Modules conventions into storage if they don't already exist.
 * Idempotent — skips any pattern that is already present at global scope.
 */
export async function seedModulesConventions(storage: LearningStorage): Promise<void> {
  return seedInstincts(storage, STRADA_MODULES_SEEDS, "strada-modules");
}
