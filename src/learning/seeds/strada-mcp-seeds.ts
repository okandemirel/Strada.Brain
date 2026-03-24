/**
 * Strada.MCP Seed Knowledge
 *
 * Seeds the learning pipeline with Strada.MCP conventions at boot.
 * Only seeded when Strada.MCP is detected as installed.
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type { SeedInstinct } from "./strada-core-seeds.js";
import { seedInstincts } from "./seed-utils.js";

/** Three foundational Strada.MCP convention instincts seeded at boot */
export const STRADA_MCP_SEEDS: SeedInstinct[] = [
  {
    pattern: "strada_mcp_tool_usage",
    action: { description: "Use Strada.MCP tools for Unity editor operations instead of manual script execution" },
    scope: "global",
    confidence: 0.60,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "strada_mcp_bridge_awareness",
    action: { description: "Check Strada.MCP bridge connection status before executing Unity runtime operations" },
    scope: "global",
    confidence: 0.60,
    trustLevel: "warn_enabled",
    seed: true,
  },
  {
    pattern: "strada_mcp_resource_authority",
    action: { description: "Treat Strada.MCP installed docs/resources as authoritative for tool contracts and bridge behavior" },
    scope: "global",
    confidence: 0.60,
    trustLevel: "warn_enabled",
    seed: true,
  },
];

/**
 * Seeds Strada.MCP conventions into storage if they don't already exist.
 * Idempotent — skips any pattern that is already present at global scope.
 */
export async function seedMCPConventions(storage: LearningStorage): Promise<void> {
  return seedInstincts(storage, STRADA_MCP_SEEDS, "strada-mcp");
}
