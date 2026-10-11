/**
 * AgentDB Auto-Tiering & Decay Helpers
 *
 * Extracted from AgentDBMemory — standalone functions for tier promotion/demotion,
 * decay sweeps, importance scoring, and tier limit enforcement.
 */

import type { UnifiedMemoryConfig, UnifiedMemoryEntry } from "./unified-memory.interface.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import type { MemoryId, NormalizedScore, TimestampMs } from "../../types/index.js";
import { getLogger } from "../../utils/logger.js";
import { type TextIndex, extractTerms } from "../text-index.js";

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
  /** TF-IDF index — eviction MUST mirror its Map/SQLite/HNSW removal here, else df/docCount drift and every IDF score silently skews (leak fix, measured 2026-08-23). */
  readonly textIndex: TextIndex;
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

/**
 * Where a tier's overflow goes instead of being deleted.
 *
 * Every conversation summary lands in Working, and only the auto-tiering sweep
 * (off by default) ever moved an entry out of it, so deleting Working's
 * overflow made conversation memory a ring buffer of its cap — the oldest
 * turns were gone for good although the docs promise long-term storage
 * (audit memory-rag#3). The overflow skips Ephemeral: its TTL would expire
 * the moved rows within a day. Ephemeral's own cap is a documented eviction,
 * and Persistent is the last tier, so both still delete.
 */
const OVERFLOW_TIER: Partial<Record<MemoryTier, MemoryTier>> = {
  [MemoryTier.Working]: MemoryTier.Persistent,
};

/** Enforce maximum entries per tier: move the lowest-scoring overflow to a colder tier, or evict it. */
export async function enforceTierLimits(ctx: AgentDBTieringContext, tier: MemoryTier): Promise<void> {
  const maxEntries = ctx.config.maxEntriesPerTier[tier];
  const entries = Array.from(ctx.entries.values()).filter((e) => e.tier === tier);

  if (entries.length > maxEntries) {
    // Sort by importance and access frequency, ascending — index 0 is evicted.
    //
    // NaN-safety is load-bearing here, not decorative: a comparator that ever
    // returns NaN makes the sort order implementation-defined, which turns
    // "evict the least valuable" into "evict something arbitrary" — including
    // the most important memories in the tier. Every write path currently
    // guards these fields, so this is hardening rather than a fix for an
    // observed failure; the cost is one clamp per comparison and the downside
    // of getting it wrong is silent, unrecoverable data loss.
    const evictionScore = (e: { importanceScore: number; accessCount: number }): number => {
      const importance = Number.isFinite(e.importanceScore) ? e.importanceScore : 0;
      const access = Number.isFinite(e.accessCount) ? e.accessCount : 0;
      return importance * 0.7 + (access / 100) * 0.3;
    };
    entries.sort((a, b) => evictionScore(a) - evictionScore(b));

    const toRemove = entries.slice(0, entries.length - maxEntries);
    const overflowTier = OVERFLOW_TIER[tier];
    if (overflowTier !== undefined) {
      for (const entry of toRemove) {
        const moved = await ctx.demoteEntry(entry.id, overflowTier);
        if (moved.kind === "err") {
          // Left over the cap rather than deleted; the next write retries.
          getLoggerSafe().warn("[AgentDBMemory] Tier overflow could not be moved", {
            id: entry.id as string, from: tier, to: overflowTier, error: moved.error.message,
          });
        }
      }
      getLoggerSafe().debug("[AgentDBMemory] Moved tier overflow", { from: tier, to: overflowTier, moved: toRemove.length });
      await enforceTierLimits(ctx, overflowTier);
      return;
    }

    // Remove lowest scoring entries
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
      // Mirror the removal in the TF-IDF index BEFORE dropping the entry —
      // extractTerms needs the content that is about to leave ctx.entries.
      ctx.textIndex.removeDocument(extractTerms(entry.content));
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

/**
 * How far a decayed score must move from the score last written for it before
 * a pass writes it again. A 5-minute pass moves a Persistent score by about
 * 2e-6, and writing every step wrote nearly every entry on every pass.
 * Holding a write back loses nothing: what is on disk is a score together
 * with the decayedAt it was decayed to, and decaying that pair to any later
 * time gives the in-memory value, so a restart arrives at the same score.
 */
export const DECAY_PERSIST_EPSILON = 0.01;

/**
 * The score last written for each entry. An entry no pass has seen yet holds
 * the score it was loaded or stored with, which is the one on disk.
 */
const persistedScores = new WeakMap<UnifiedMemoryEntry, number>();

/**
 * Exponential decay pass over every non-exempt entry. Runs inside the
 * auto-tiering sweep and, with auto-tiering off, on its own timer
 * (AgentDBMemory.startDecay) — it used to run only inside the sweep, so the
 * default-on MEMORY_DECAY_ENABLED never decayed anything (audit memory-rag#3).
 */
export function decaySweep(ctx: AgentDBTieringContext): void {
  const now = getNow() as number;
  if (ctx.decayConfig?.enabled) {
    const lambdas: Record<MemoryTier, number> = {
      [MemoryTier.Working]: ctx.decayConfig.lambdas.working,
      [MemoryTier.Ephemeral]: ctx.decayConfig.lambdas.ephemeral,
      [MemoryTier.Persistent]: ctx.decayConfig.lambdas.persistent,
    };
    const exemptDomains = ctx.decayConfig.exemptDomains;
    const decayedEntryIds: string[] = [];

    const decaySnapshot = Array.from(ctx.entries.values());
    for (const entry of decaySnapshot) {
      // Skip exempt domains
      if (entry.domain && exemptDomains.includes(entry.domain)) continue;

      // Decay only the time not yet decayed. The score is already decayed up
      // to the last sweep; multiplying by exp(-lambda * daysSinceAccess) on
      // every sweep compounded, collapsing importance within days at a
      // 5-minute interval and evicting memories that should have lasted (MEM-6).
      const decayFrom = Math.max(entry.lastAccessedAt as number, (entry.decayedAt as number | undefined) ?? 0);
      const daysUndecayed = (now - decayFrom) / MS_PER_DAY;
      if (daysUndecayed <= 0) continue; // just accessed or just decayed

      const lambda = lambdas[entry.tier];
      const decayed = entry.importanceScore * Math.exp(-daysUndecayed * lambda);
      const newScore = Math.max(decayed, 0.01) as NormalizedScore;
      const written = persistedScores.get(entry) ?? entry.importanceScore;
      entry.decayedAt = now as TimestampMs;
      entry.importanceScore = newScore;

      const moved = Math.abs(newScore - written) >= DECAY_PERSIST_EPSILON;
      persistedScores.set(entry, moved ? newScore : written);
      if (moved) decayedEntryIds.push(entry.id as string);
    }

    // Batch persist only the entries whose scores moved by the epsilon
    if (decayedEntryIds.length > 0) {
      persistDecayedEntries(ctx, decayedEntryIds);
      getLoggerSafe().debug("[AgentDBMemory] Decay sweep complete", { decayedCount: decayedEntryIds.length });
    }
  }
}

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

  decaySweep(ctx);

  const tieringSnapshot = Array.from(ctx.entries.values());
  for (const entry of tieringSnapshot) {
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
