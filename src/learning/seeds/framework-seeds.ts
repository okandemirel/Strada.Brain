/**
 * Framework Seeds -- Unified Entry Point
 *
 * Seeds conventions for all installed Strada packages.
 * Replaces direct calls to seedStradaConventions() in the learning pipeline.
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import { seedStradaConventions } from "./strada-core-seeds.js";
import { seedModulesConventions } from "./strada-modules-seeds.js";
import { seedMCPConventions } from "./strada-mcp-seeds.js";

/**
 * Seed conventions for all installed framework packages.
 * Core is always seeded (it's the foundation). Modules and MCP
 * are seeded only when detected as installed.
 */
export async function seedAllFrameworkConventions(
  storage: LearningStorage,
  stradaDeps?: StradaDepsStatus,
): Promise<void> {
  // Always seed Core (foundational conventions)
  await seedStradaConventions(storage);

  // Seed Modules only if installed
  if (stradaDeps?.modulesInstalled) {
    await seedModulesConventions(storage);
  }

  // Seed MCP only if installed
  if (stradaDeps?.mcpInstalled) {
    await seedMCPConventions(storage);
  }
}
