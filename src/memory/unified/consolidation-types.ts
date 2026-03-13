/**
 * Memory Consolidation Types
 *
 * Defines interfaces for the memory consolidation engine that clusters
 * similar memories using HNSW kNN search and LLM summarization.
 */

import type { MemoryTier } from "./unified-memory.interface.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Configuration for memory consolidation engine */
export interface ConsolidationConfig {
  readonly enabled: boolean;
  /** Minutes of idle time before consolidation triggers */
  readonly idleMinutes: number;
  /** Cosine similarity threshold for clustering (0.5-0.99) */
  readonly threshold: number;
  /** Max entries to consider per consolidation cycle */
  readonly batchSize: number;
  /** Minimum entries in a cluster to consolidate */
  readonly minClusterSize: number;
  /** Max recursive consolidation depth */
  readonly maxDepth: number;
  /** LLM model tier for summarization */
  readonly modelTier: string;
  /** Minimum age in ms before entry is eligible for consolidation */
  readonly minAgeMs: number;
}

// =============================================================================
// CLUSTER TYPES
// =============================================================================

/** A cluster of similar memory entries within the same tier */
export interface MemoryCluster {
  /** ID of the seed entry that started the cluster */
  readonly seedId: string;
  /** IDs of all entries in the cluster (including seed) */
  readonly memberIds: string[];
  /** Average pairwise similarity score */
  readonly avgSimilarity: number;
  /** Tier all entries belong to */
  readonly tier: MemoryTier;
}

// =============================================================================
// RESULT TYPES
// =============================================================================

/** Result of a consolidation cycle */
export interface ConsolidationResult {
  /** Whether the cycle completed, was interrupted, or skipped */
  readonly status: "completed" | "interrupted" | "skipped";
  /** Number of clusters processed */
  readonly processed: number;
  /** Number of clusters remaining (unprocessed) */
  readonly remaining: number;
  /** Total clusters found across all tiers */
  readonly clustersFound: number;
  /** Estimated USD cost of LLM calls */
  readonly costUsd: number;
}

/** A dry-run preview of what consolidation would do */
export interface ConsolidationPreview {
  /** Clusters that would be consolidated */
  readonly clusters: MemoryCluster[];
  /** Estimated cost per cluster */
  readonly estimatedCostPerCluster: number;
  /** Total estimated cost */
  readonly totalEstimatedCost: number;
}

// =============================================================================
// LOG TYPES
// =============================================================================

/** A record of a single consolidation operation */
export interface ConsolidationLogEntry {
  readonly id: string;
  /** ID of the summary entry created */
  readonly summaryEntryId: string;
  /** IDs of entries that were consolidated into the summary */
  readonly sourceEntryIds: string[];
  /** Average similarity score of the cluster */
  readonly similarityScore: number;
  /** LLM model used for summarization */
  readonly modelUsed: string;
  /** USD cost of the summarization call */
  readonly cost: number;
  /** Timestamp of the consolidation */
  readonly timestamp: number;
  /** Consolidation depth (1 = first consolidation, 2+ = recursive) */
  readonly depth: number;
  /** Status of the log entry */
  readonly status: "completed" | "undone";
  /** Agent ID in multi-agent mode */
  readonly agentId?: string;
}

// =============================================================================
// STATS TYPES
// =============================================================================

/** Per-tier consolidation statistics */
export interface ConsolidationTierStats {
  /** Entries that have been consolidated (soft-deleted) */
  readonly clustered: number;
  /** Entries pending consolidation */
  readonly pending: number;
  /** Total entries in tier */
  readonly total: number;
}

/** Overall consolidation statistics */
export interface ConsolidationStats {
  /** Per-tier breakdown */
  readonly perTier: Record<string, ConsolidationTierStats>;
  /** Lifetime entries saved (consolidated - summaries created) */
  readonly lifetimeSavings: number;
  /** Total consolidation runs */
  readonly totalRuns: number;
  /** Total USD cost across all runs */
  readonly totalCostUsd: number;
}
