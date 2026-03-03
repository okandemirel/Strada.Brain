/**
 * Unified Memory Interface for AgentDB + HNSW Integration
 *
 * Implements ADR-006 (Unified Memory Service) and ADR-009 (Hybrid Memory Backend)
 * Provides 3-tier memory architecture with HNSW vector indexing for 150x-12,500x performance
 */

import type {
  RetrievalOptions,
  RetrievalResult,
  MemoryStats,
  MemoryEntryType,
  MemoryImportance,
  MemoryMetadata,
  MemoryEntry,
} from "../memory.interface.js";
import type { MemoryId } from "../../types/index.js";
import type { StrataProjectAnalysis } from "../../intelligence/strata-analyzer.js";
import type {
  Result,
  Option,
  ChatId,
  TimestampMs,
  DurationMs,
  NormalizedScore,
  Vector,
  VectorId,
} from "../../types/index.js";

// =============================================================================
// MEMORY TIER TYPES
// =============================================================================

/**
 * Memory tier levels for organizing memory entries based on importance and retention
 */
export enum MemoryTier {
  /** Working memory - Active context, current session, high turnover */
  Working = "working",
  /** Ephemeral memory - Short-term storage, last N conversations */
  Ephemeral = "ephemeral",
  /** Persistent memory - Long-term knowledge, important facts */
  Persistent = "persistent",
}

/** Tier configuration */
export interface TierConfig {
  /** Maximum entries in this tier */
  readonly maxEntries: number;
  /** Default TTL for entries in this tier */
  readonly defaultTtl: DurationMs;
  /** Whether to use HNSW indexing */
  readonly useHnsw: boolean;
  /** Compression level (0-9, 0 = none) */
  readonly compressionLevel: number;
}

/** Tier statistics */
export interface TierStats {
  readonly tier: MemoryTier;
  readonly entryCount: number;
  readonly maxEntries: number;
  readonly oldestEntryAt?: TimestampMs;
  readonly newestEntryAt?: TimestampMs;
  readonly averageImportance: NormalizedScore;
}

// =============================================================================
// UNIFIED MEMORY ENTRY
// =============================================================================

/**
 * Base unified memory entry properties
 */
interface BaseUnifiedMemoryEntry {
  // Core identity (readonly)
  readonly id: MemoryId;
  readonly type: MemoryEntryType;
  readonly content: string;
  readonly createdAt: TimestampMs;
  readonly tags: string[];
  readonly importance: MemoryImportance;
  readonly archived: boolean;
  readonly metadata: MemoryMetadata;
  readonly chatId: ChatId;

  // Unified-specific (readonly)
  readonly embedding: Vector<number>;
  readonly domain?: string;

  // Mutable state
  tier: MemoryTier;
  accessCount: number;
  lastAccessedAt: TimestampMs;
  expiresAt?: TimestampMs;
  importanceScore: NormalizedScore;
  hnswIndex?: number;
  version: number;
}

/** Unified conversation entry */
export interface UnifiedConversationMemoryEntry extends BaseUnifiedMemoryEntry {
  readonly type: "conversation";
  readonly chatId: ChatId;
  readonly userMessage: string;
  readonly assistantMessage?: string;
  turnNumber?: number;
}

/** Unified analysis entry - omit base version since analysis uses string version */
export interface UnifiedAnalysisMemoryEntry extends Omit<BaseUnifiedMemoryEntry, "version"> {
  readonly type: "analysis";
  readonly projectPath: string;
  readonly category: "structure" | "quality" | "dependencies" | "performance";
  readonly analysisVersion: string;
}

/** Unified note entry */
export interface UnifiedNoteMemoryEntry extends BaseUnifiedMemoryEntry {
  readonly type: "note" | "insight";
  readonly title?: string;
  readonly source: string;
}

/** Unified error entry */
export interface UnifiedErrorMemoryEntry extends BaseUnifiedMemoryEntry {
  readonly type: "error";
  readonly errorCategory: string;
  readonly errorCode?: string;
  readonly location?: string;
  readonly resolved: boolean;
  readonly resolution?: string;
}

/** Unified command entry */
export interface UnifiedCommandMemoryEntry extends BaseUnifiedMemoryEntry {
  readonly type: "command";
  readonly command: string;
  readonly workingDirectory: string;
  readonly exitCode: number;
  readonly success: boolean;
}

/** Unified task entry */
export interface UnifiedTaskMemoryEntry extends BaseUnifiedMemoryEntry {
  readonly type: "task";
  readonly task: string;
  readonly status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  readonly parentTaskId?: MemoryId;
  readonly dueDate?: TimestampMs;
}

/** Unified memory entry discriminated union */
export type UnifiedMemoryEntry =
  | UnifiedConversationMemoryEntry
  | UnifiedAnalysisMemoryEntry
  | UnifiedNoteMemoryEntry
  | UnifiedErrorMemoryEntry
  | UnifiedCommandMemoryEntry
  | UnifiedTaskMemoryEntry;

/** Entry with vector ID */
export interface VectorizedEntry {
  readonly id: string;
  readonly vector: Vector<number>;
  readonly chunk: {
    readonly id: string;
    readonly filePath: string;
    readonly content: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly kind: string;
    readonly contentHash: string;
    readonly indexedAt: string;
  };
}

// =============================================================================
// QUERY TYPES
// =============================================================================

/** Search mode for unified memory */
export type SearchMode = "exact" | "semantic" | "hybrid" | "fulltext";

/** Base unified memory query */
interface BaseUnifiedQuery {
  /** Enable semantic vector search */
  readonly semantic?: boolean;
  /** Vector embedding for semantic search */
  readonly embedding?: Vector<number>;
  /** Filter by memory tier */
  readonly tier?: MemoryTier;
  /** Filter by domain */
  readonly domain?: string;
  /** Minimum importance score */
  readonly minImportance?: NormalizedScore;
  /** Include expired ephemeral entries */
  readonly includeExpired?: boolean;
  /** Use MMR for diverse results */
  readonly useMMR?: boolean;
  /** MMR diversity parameter (0-1) */
  readonly mmrLambda?: NormalizedScore;
  /** Filter by entry type */
  readonly type?: MemoryEntryType;
}

/** Unified memory query extending retrieval options */
export interface UnifiedMemoryQuery extends BaseUnifiedQuery, Omit<RetrievalOptions, "mode"> {
  /** Search mode */
  readonly mode?: SearchMode;
  /** Query text (for text/hybrid search) */
  readonly query?: string;
  /** Chat ID filter */
  readonly chatId?: ChatId;
}

/** Semantic search query */
export interface SemanticQuery extends BaseUnifiedQuery {
  readonly mode: "semantic";
  readonly query: string;
  readonly embedding?: never; // Will be computed
}

/** Hybrid search query */
export interface HybridQuery extends BaseUnifiedQuery {
  readonly mode: "hybrid";
  readonly query: string;
  /** Weight for semantic vs fulltext (0-1) */
  readonly semanticWeight?: NormalizedScore;
}

/** Vector query (direct embedding) */
export interface VectorQuery extends BaseUnifiedQuery {
  readonly mode: "semantic";
  readonly embedding: Vector<number>;
  readonly query?: never;
}

// =============================================================================
// HNSW INDEX TYPES
// =============================================================================

/** HNSW index statistics */
export interface HnswStats {
  readonly indexedVectors: number;
  readonly dimensions: number;
  readonly efConstruction: number;
  readonly M: number;
  readonly efSearch: number;
  readonly maxElements: number;
  readonly currentCount: number;
  readonly memoryUsedBytes: number;
}

/** HNSW search result */
export interface HnswSearchResult {
  readonly id: VectorId;
  readonly distance: number;
  readonly index: number;
}

/** HNSW index health */
export interface HnswHealth {
  readonly isHealthy: boolean;
  readonly issues: string[];
  readonly fillRatio: NormalizedScore;
  readonly averageConnections: number;
  readonly fragmentationRatio: NormalizedScore;
}

// =============================================================================
// QUANTIZATION TYPES
// =============================================================================

/** Quantization types for memory efficiency */
export type QuantizationType = "none" | "binary" | "scalar" | "product";

/** Quantization configuration */
export interface QuantizationConfig {
  readonly type: QuantizationType;
  readonly bits?: number;
  readonly trainingSize?: number;
}

/** Quantization statistics */
export interface QuantizationStats {
  readonly type: QuantizationType;
  readonly originalSizeBytes: number;
  readonly compressedSizeBytes: number;
  readonly compressionRatio: number;
  readonly bitsPerDimension: number;
}

// =============================================================================
// MIGRATION TYPES
// =============================================================================

/** Migration status tracking */
export interface MigrationStatus {
  /** Migration version */
  version: number;
  /** Whether migration is complete */
  isComplete: boolean;
  /** Source system (e.g., "tfidf", "file-memory") */
  sourceSystem: string;
  /** Number of entries migrated */
  entriesMigrated: number;
  /** Number of entries failed */
  entriesFailed: number;
  /** Migration started timestamp */
  startedAt: TimestampMs;
  /** Migration completed timestamp */
  completedAt?: TimestampMs;
  /** Errors encountered during migration */
  errors: string[];
}

/** Migration progress callback */
export type MigrationProgressCallback = (progress: {
  readonly total: number;
  readonly migrated: number;
  readonly failed: number;
  readonly percentage: NormalizedScore;
}) => void;

// =============================================================================
// PERFORMANCE TYPES
// =============================================================================

/** Performance metrics */
export interface PerformanceMetrics {
  readonly avgSearchTimeMs: number;
  readonly lastSearchTimeMs: number;
  readonly totalSearches: number;
  readonly cacheHitRate: NormalizedScore;
  readonly indexBuildTimeMs: number;
  readonly memoryUsageBytes: number;
}

/** Cache statistics */
export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly currentSize: number;
  readonly maxSize: number;
  readonly hitRate: NormalizedScore;
}

/** Extended memory statistics */
export interface UnifiedMemoryStats extends MemoryStats {
  readonly entriesByTier: Record<MemoryTier, number>;
  readonly hnswStats: HnswStats;
  readonly quantizationStats: QuantizationStats;
  readonly performance: PerformanceMetrics;
  readonly cacheStats: CacheStats;
  readonly tierStats: Record<MemoryTier, TierStats>;
}

// =============================================================================
// UNIFIED MEMORY INTERFACE
// =============================================================================

/**
 * Unified Memory Manager Interface
 *
 * Replaces legacy IMemoryManager with AgentDB + HNSW backend
 * Maintains backward compatibility while providing enhanced capabilities
 */
export interface IUnifiedMemory {
  /** Initialize the memory store (load from disk, build HNSW index) */
  initialize(): Promise<Result<void, Error>>;

  /** Shut down and flush pending writes */
  shutdown(): Promise<Result<void, Error>>;

  // --- Project Analysis Cache ---

  /** Cache a project analysis result */
  cacheAnalysis(analysis: StrataProjectAnalysis, projectPath: string): Promise<Result<void, Error>>;

  /** Get cached analysis if still valid (not older than maxAgeMs) */
  getCachedAnalysis(
    projectPath: string,
    maxAgeMs?: DurationMs,
  ): Promise<StrataProjectAnalysis | null>;

  // --- Conversation Memory ---

  /** Store a conversation summary with automatic tier assignment */
  storeConversation(
    chatId: ChatId,
    summary: string,
    tags?: string[],
    tier?: MemoryTier,
  ): Promise<MemoryEntry>;

  /** Store a general note or insight */
  storeNote(content: string, tags?: string[], tier?: MemoryTier): Promise<MemoryEntry>;

  /** Store an entry with full control over metadata */
  storeEntry(
    entry: Omit<
      UnifiedMemoryEntry,
      "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version"
    >,
  ): Promise<Result<MemoryEntry, Error>>;

  /** Batch store entries */
  storeEntries(
    entries: Array<
      Omit<UnifiedMemoryEntry, "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version">
    >,
  ): Promise<Result<MemoryId[], Error>>;

  // --- Retrieval ---

  /** Search memory using text query (TF-IDF backward compatibility) */
  retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult<MemoryEntry>[]>;

  /** Semantic search using HNSW vector indexing */
  retrieveSemantic(
    query: string,
    options?: UnifiedMemoryQuery,
  ): Promise<RetrievalResult<MemoryEntry>[]>;

  /** Retrieve with vector embedding directly */
  retrieveByEmbedding(
    embedding: Vector<number>,
    options?: UnifiedMemoryQuery,
  ): Promise<RetrievalResult<MemoryEntry>[]>;

  /** Hybrid search combining semantic and text */
  retrieveHybrid(
    query: string,
    options?: {
      semanticWeight?: NormalizedScore;
      tier?: MemoryTier;
      limit?: number;
      useMMR?: boolean;
    },
  ): Promise<RetrievalResult<MemoryEntry>[]>;

  /** Get all entries for a chat (chronological) */
  getChatHistory(chatId: ChatId, limit?: number): Promise<MemoryEntry[]>;

  /** Get entries by tier */
  getByTier(tier: MemoryTier, limit?: number): Promise<MemoryEntry[]>;

  /** Get entry by ID */
  getById(id: MemoryId): Promise<Result<Option<MemoryEntry>, Error>>;

  // --- Memory Management ---

  /** Promote entry to higher tier */
  promoteEntry(id: MemoryId, newTier: MemoryTier): Promise<Result<MemoryEntry, Error>>;

  /** Demote entry to lower tier */
  demoteEntry(id: MemoryId, newTier: MemoryTier): Promise<Result<MemoryEntry, Error>>;

  /** Update entry importance */
  updateImportance(id: MemoryId, importance: NormalizedScore): Promise<Result<MemoryEntry, Error>>;

  /** Touch entry (update access count and timestamp) */
  touch(id: MemoryId): Promise<Result<void, Error>>;

  /** Remove expired ephemeral entries */
  cleanupExpired(): Promise<number>;

  /** Compact and optimize storage */
  compact(): Promise<{ freedBytes: number }>;

  /** Delete entry */
  delete(id: MemoryId): Promise<Result<boolean, Error>>;

  // --- Stats & Health ---

  /** Get comprehensive memory statistics */
  getStats(): UnifiedMemoryStats;

  /** Get migration status */
  getMigrationStatus(): MigrationStatus;

  // --- HNSW Index Operations ---

  /** Rebuild HNSW index (after bulk operations) */
  rebuildIndex(): Promise<Result<void, Error>>;

  /** Get HNSW index health status */
  getIndexHealth(): HnswHealth;

  /** Optimize HNSW parameters based on usage */
  optimizeIndex(): Promise<Result<void, Error>>;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configuration for unified memory initialization
 */
export interface UnifiedMemoryConfig {
  /** Database path */
  readonly dbPath: string;
  /** Vector dimensions (1536 for OpenAI, 768 for sentence-transformers) */
  readonly dimensions: number;
  /** Maximum entries per tier */
  readonly maxEntriesPerTier: {
    readonly [MemoryTier.Working]: number;
    readonly [MemoryTier.Ephemeral]: number;
    readonly [MemoryTier.Persistent]: number;
  };
  /** Tier configurations */
  readonly tierConfigs?: Partial<Record<MemoryTier, Partial<TierConfig>>>;
  /** HNSW index parameters */
  readonly hnswParams: {
    readonly efConstruction: number;
    readonly M: number;
    readonly efSearch: number;
  };
  /** Quantization type for memory efficiency */
  readonly quantizationType: QuantizationType;
  /** Cache size for in-memory patterns */
  readonly cacheSize: number;
  /** Enable automatic tier promotion based on access patterns */
  readonly enableAutoTiering: boolean;
  /** Ephemeral entry TTL in milliseconds */
  readonly ephemeralTtlMs: DurationMs;
  /** Auto-compact threshold (0-1, percentage of max) */
  readonly autoCompactThreshold?: NormalizedScore;
  /** Optional embedding provider function — when not set, a hash-based fallback is used */
  readonly embeddingProvider?: (text: string) => Promise<number[]>;
}

/**
 * Default configuration for unified memory
 */
export const DEFAULT_MEMORY_CONFIG: UnifiedMemoryConfig = {
  dbPath: ".memory/agentdb",
  dimensions: 1536,
  maxEntriesPerTier: {
    [MemoryTier.Working]: 100,
    [MemoryTier.Ephemeral]: 1000,
    [MemoryTier.Persistent]: 10000,
  },
  hnswParams: {
    efConstruction: 200,
    M: 16,
    efSearch: 128,
  },
  quantizationType: "scalar",
  cacheSize: 1000,
  enableAutoTiering: true,
  ephemeralTtlMs: (24 * 60 * 60 * 1000) as DurationMs, // 24 hours
  autoCompactThreshold: 0.9 as NormalizedScore,
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Determine appropriate tier based on importance and content
 */
export function determineTier(
  importance: NormalizedScore,
  isEphemeral: boolean = false,
): MemoryTier {
  if (importance >= 0.8) return MemoryTier.Persistent;
  if (isEphemeral || importance <= 0.3) return MemoryTier.Ephemeral;
  return MemoryTier.Working;
}

/**
 * Calculate tier based on access patterns
 */
export function calculateTierFromAccess(
  accessCount: number,
  lastAccessedAt: TimestampMs,
  now: TimestampMs = Date.now() as TimestampMs,
): MemoryTier {
  const daysSinceAccess = (now - lastAccessedAt) / (1000 * 60 * 60 * 24);

  if (accessCount > 10 && daysSinceAccess < 1) {
    return MemoryTier.Working;
  }
  if (accessCount > 3 && daysSinceAccess < 7) {
    return MemoryTier.Ephemeral;
  }
  return MemoryTier.Persistent;
}

/**
 * Check if entry is expired
 */
export function isEntryExpired(
  entry: UnifiedMemoryEntry,
  now: TimestampMs = Date.now() as TimestampMs,
): boolean {
  if (entry.expiresAt === undefined) return false;
  return now > entry.expiresAt;
}

/**
 * Create a unified memory entry
 */
export function createUnifiedEntry(
  baseEntry: Omit<
    UnifiedMemoryEntry,
    "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version"
  >,
  options: {
    embedding: Vector<number>;
    tier: MemoryTier;
    importanceScore?: NormalizedScore;
    domain?: string;
    expiresAt?: TimestampMs;
  },
): Omit<UnifiedMemoryEntry, "id" | "createdAt"> {
  const now = Date.now() as TimestampMs;
  const entry = {
    ...baseEntry,
    embedding: options.embedding,
    tier: options.tier,
    accessCount: 0,
    lastAccessedAt: now,
    importanceScore: options.importanceScore ?? (0.5 as NormalizedScore),
    domain: options.domain,
    expiresAt: options.expiresAt,
    version: 1,
  };
  return entry as Omit<UnifiedMemoryEntry, "id" | "createdAt">;
}

/**
 * Merge retrieval results from multiple tiers
 */
export function mergeRetrievalResults(
  results: RetrievalResult<MemoryEntry>[][],
  limit: number,
): RetrievalResult<MemoryEntry>[] {
  const all = results.flat();
  // Sort by score descending
  all.sort((a, b) => b.score - a.score);
  // Remove duplicates by ID
  const seen = new Set<string>();
  return all
    .filter((r) => {
      if (seen.has(r.entry.id as string)) return false;
      seen.add(r.entry.id as string);
      return true;
    })
    .slice(0, limit);
}
