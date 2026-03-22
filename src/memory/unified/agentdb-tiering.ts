/**
 * AgentDB Auto-Tiering & Decay Helpers
 *
 * Extracted from AgentDBMemory — standalone functions for tier promotion/demotion,
 * decay sweeps, importance scoring, and tier limit enforcement.
 */

import type { UnifiedMemoryConfig } from "./unified-memory.interface.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import type { MemoryId, NormalizedScore } from "../../types/index.js";
import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try { return getLogger(); } catch { return console; }
}
import { MS_PER_DAY } from "../../learning/types.js";
import type { MemoryDecayConfig } from "../memory.interface.js";
import type { HnswWriteMutex } from "./hnsw-write-mutex.js";
import type { AgentDBSqliteContext } from "./agentdb-sqlite.js";
import { persistDecayedEntries, removePersistedEntry } from "./agentdb-sqlite.js";
import { getNow } from "./agentdb-time.js";

// ---------------------------------------------------------------------------
// Context required by tiering helpers
// ---------------------------------------------------------------------------

export interface AgentDBTieringContext extends AgentDBSqliteContext {
  readonly config: UnifiedMemoryConfig;
  readonly hnswStore: HNSWVectorStore | undefined;
  readonly writeMutex: HnswWriteMutex;
  readonly decayConfig: MemoryDecayConfig | null;
  promoteEntry(id: MemoryId, newTier: MemoryTier): Promise<import("../../types/index.js").Result<import("../memory.interface.js").MemoryEntry, Error>>;
  demoteEntry(id: MemoryId, newTier: MemoryTier): Promise<import("../../types/index.js").Result<import("../memory.interface.js").MemoryEntry, Error>>;
  /** Optional override so callers (e.g. the class) can intercept calls for test spying. */
  enforceTierLimitsOverride?: (tier: MemoryTier) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Importance scoring
// ---------------------------------------------------------------------------

/** Calculate an importance score for a memory entry based on content and tier. */
export function calculateImportanceScore(content: string, tier: MemoryTier): NormalizedScore {
  const tierImportance = {
    [MemoryTier.Working]: 0.3,
    [MemoryTier.Ephemeral]: 0.5,
    [MemoryTier.Persistent]: 0.8,
  };

  // Content length factor (longer = potentially more important)
  const lengthFactor = Math.min(content.length / 1000, 0.2);

  // Keyword factor (presence of important keywords)
  const importantKeywords = ["important", "critical", "key", "main", "essential", "vital"];
  const keywordFactor = importantKeywords.some((kw) => content.toLowerCase().includes(kw))
    ? 0.1
    : 0;

  return Math.min(tierImportance[tier] + lengthFactor + keywordFactor, 1.0) as NormalizedScore;
}

// ---------------------------------------------------------------------------
// Tier limit enforcement
// ---------------------------------------------------------------------------

/** Enforce maximum entries per tier, evicting the lowest-scoring entries. */
export async function enforceTierLimits(ctx: AgentDBTieringContext, tier: MemoryTier): Promise<void> {
  const maxEntries = ctx.config.maxEntriesPerTier[tier];
  const entries = Array.from(ctx.entries.values()).filter((e) => e.tier === tier);

  if (entries.length > maxEntries) {
    // Sort by importance and last accessed
    entries.sort((a, b) => {
      const scoreA = a.importanceScore * 0.7 + (a.accessCount / 100) * 0.3;
      const scoreB = b.importanceScore * 0.7 + (b.accessCount / 100) * 0.3;
      return scoreA - scoreB;
    });

    // Remove lowest scoring entries
    const toRemove = entries.slice(0, entries.length - maxEntries);
    if (ctx.hnswStore) {
      const store = ctx.hnswStore;
      const ids = toRemove.map(e => e.id as string);
      await ctx.writeMutex.withLock(async () => {
        for (const id of ids) {
          await store.remove([id]);
        }
      });
    }
    for (const entry of toRemove) {
      ctx.entries.delete(entry.id as string);
      removePersistedEntry(ctx, entry.id as string);
    }

    getLoggerSafe().debug("[AgentDBMemory] Enforced tier limits", {
      tier,
      removed: toRemove.length,
    });
  }
}

// ---------------------------------------------------------------------------
// Auto-tiering sweep (decay + promotion/demotion)
// ---------------------------------------------------------------------------

/** Run a full auto-tiering sweep: decay pass, then promote/demote entries. */
export async function autoTieringSweep(
  ctx: AgentDBTieringContext,
  promotionThreshold: number,
  demotionTimeoutDays: number,
): Promise<void> {
  const now = getNow() as number;
  const tierOrder = { [MemoryTier.Working]: 0, [MemoryTier.Ephemeral]: 1, [MemoryTier.Persistent]: 2 };
  let promoted = 0;
  let demoted = 0;

  // --- Decay pass (before tiering) ---
  if (ctx.decayConfig?.enabled) {
    const lambdas: Record<MemoryTier, number> = {
      [MemoryTier.Working]: ctx.decayConfig.lambdas.working,
      [MemoryTier.Ephemeral]: ctx.decayConfig.lambdas.ephemeral,
      [MemoryTier.Persistent]: ctx.decayConfig.lambdas.persistent,
    };
    const exemptDomains = ctx.decayConfig.exemptDomains;
    const decayedEntryIds: string[] = [];

    for (const entry of ctx.entries.values()) {
      // Skip exempt domains
      if (entry.domain && exemptDomains.includes(entry.domain)) continue;

      const daysSinceAccess = (now - (entry.lastAccessedAt as number)) / MS_PER_DAY;
      if (daysSinceAccess <= 0) continue; // just accessed, no decay

      const lambda = lambdas[entry.tier];
      const decayed = entry.importanceScore * Math.exp(-daysSinceAccess * lambda);
      const newScore = Math.max(decayed, 0.01) as NormalizedScore;

      if (newScore !== entry.importanceScore) {
        entry.importanceScore = newScore;
        decayedEntryIds.push(entry.id as string);
      }
    }

    // Batch persist only the entries whose scores actually changed
    if (decayedEntryIds.length > 0) {
      persistDecayedEntries(ctx, decayedEntryIds);
      getLoggerSafe().debug("[AgentDBMemory] Decay sweep complete", { decayedCount: decayedEntryIds.length });
    }
  }

  for (const entry of ctx.entries.values()) {
    const daysSinceAccess = (now - (entry.lastAccessedAt as number)) / MS_PER_DAY;
    const currentTier = entry.tier;
    let targetTier = currentTier;

    // Promotion: high access frequency + recent access -> hotter tier
    if (entry.accessCount >= promotionThreshold && daysSinceAccess < 1) {
      if (currentTier === MemoryTier.Persistent) targetTier = MemoryTier.Ephemeral;
      else if (currentTier === MemoryTier.Ephemeral) targetTier = MemoryTier.Working;
    }
    // Demotion: stale -> colder tier
    else if (daysSinceAccess > demotionTimeoutDays) {
      if (currentTier === MemoryTier.Working) targetTier = MemoryTier.Ephemeral;
      else if (currentTier === MemoryTier.Ephemeral) targetTier = MemoryTier.Persistent;
    }

    if (targetTier !== currentTier) {
      const isPromotion = tierOrder[targetTier] < tierOrder[currentTier];

      if (isPromotion) {
        await ctx.promoteEntry(entry.id, targetTier);
        promoted++;
      } else {
        await ctx.demoteEntry(entry.id, targetTier);
        demoted++;
      }
      getLoggerSafe().debug(`[AgentDBMemory] Entry ${entry.id} ${isPromotion ? "promoted" : "demoted"} ${currentTier}->${targetTier}`);
    }
  }

  // After promotions/demotions, enforce limits on all tiers (cascade eviction)
  const enforce = ctx.enforceTierLimitsOverride ?? ((tier: MemoryTier) => enforceTierLimits(ctx, tier));
  for (const tier of [MemoryTier.Working, MemoryTier.Ephemeral, MemoryTier.Persistent]) {
    await enforce(tier);
  }

  if (promoted > 0 || demoted > 0) {
    getLoggerSafe().debug("[AgentDBMemory] Auto-tiering sweep complete", { promoted, demoted });
  }
}
