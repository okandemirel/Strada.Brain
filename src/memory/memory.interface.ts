/**
 * Type-safe Memory Manager Interface for Strada.Brain
 * 
 * Provides:
 * - Type-safe memory entry types
 * - Structured retrieval options
 * - Brand types for IDs
 */

import type { 
  StradaProjectAnalysis 
} from "../intelligence/strada-analyzer.js";
import type { 
  Result,
  Option,
  MemoryId,
  ChatId,
  TimestampMs,
  DurationMs,
  NormalizedScore,
  Vector,
  JsonObject 
} from "../types/index.js";

// =============================================================================
// MEMORY ENTRY TYPES
// =============================================================================

/** Memory entry types */
export type MemoryEntryType = 
  | "conversation"
  | "analysis"
  | "note"
  | "command"
  | "error"
  | "insight"
  | "task";

/** Memory entry importance levels */
export type MemoryImportance = "low" | "medium" | "high" | "critical";

/** Base memory entry */
interface BaseMemoryEntry {
  /** Unique identifier */
  readonly id: MemoryId;
  /** Type of memory */
  readonly type: MemoryEntryType;
  /** The text content */
  readonly content: string;
  /** When created */
  readonly createdAt: TimestampMs;
  /** Last accessed */
  readonly lastAccessedAt?: TimestampMs;
  /** Access count */
  readonly accessCount: number;
  /** Optional tags for filtering */
  readonly tags: string[];
  /** Importance level */
  readonly importance: MemoryImportance;
  /** Whether this entry is archived */
  readonly archived: boolean;
  /** Vector embedding for semantic search */
  readonly embedding?: Vector<number>;
  /** Additional metadata */
  readonly metadata: MemoryMetadata;
}

/** Conversation memory entry */
export interface ConversationMemoryEntry extends BaseMemoryEntry {
  readonly type: "conversation";
  /** Associated chat ID */
  readonly chatId: ChatId;
  /** User message summary */
  readonly userMessage: string;
  /** Assistant response summary */
  readonly assistantMessage?: string;
  /** Conversation turn number */
  readonly turnNumber?: number;
}

/** Analysis memory entry */
export interface AnalysisMemoryEntry extends BaseMemoryEntry {
  readonly type: "analysis";
  /** Project path this analysis relates to */
  readonly projectPath: string;
  /** Analysis category */
  readonly category: "structure" | "quality" | "dependencies" | "performance";
  /** Analysis version */
  readonly version: string;
}

/** Note/insight memory entry */
export interface NoteMemoryEntry extends BaseMemoryEntry {
  readonly type: "note" | "insight";
  /** Title/summary */
  readonly title?: string;
  /** Source (e.g., user input, auto-generated) */
  readonly source: string;
}

/** Error memory entry */
export interface ErrorMemoryEntry extends BaseMemoryEntry {
  readonly type: "error";
  /** Error category */
  readonly errorCategory: string;
  /** Error code if available */
  readonly errorCode?: string;
  /** Stack trace or location */
  readonly location?: string;
  /** Whether resolved */
  readonly resolved: boolean;
  /** Resolution notes */
  readonly resolution?: string;
}

/** Command memory entry */
export interface CommandMemoryEntry extends BaseMemoryEntry {
  readonly type: "command";
  /** Command executed */
  readonly command: string;
  /** Working directory */
  readonly workingDirectory: string;
  /** Exit code */
  readonly exitCode: number;
  /** Whether successful */
  readonly success: boolean;
}

/** Task memory entry */
export interface TaskMemoryEntry extends BaseMemoryEntry {
  readonly type: "task";
  /** Task description */
  readonly task: string;
  /** Task status */
  readonly status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  /** Parent task ID if subtask */
  readonly parentTaskId?: MemoryId;
  /** Due date if applicable */
  readonly dueDate?: TimestampMs;
}

/** Discriminated union of all memory entry types */
export type MemoryEntry =
  | ConversationMemoryEntry
  | AnalysisMemoryEntry
  | NoteMemoryEntry
  | ErrorMemoryEntry
  | CommandMemoryEntry
  | TaskMemoryEntry;

// =============================================================================
// TYPE GUARDS
// =============================================================================

/** Check if entry is a conversation */
export function isConversationEntry(entry: MemoryEntry): entry is ConversationMemoryEntry {
  return entry.type === "conversation";
}

/** Check if entry is an analysis */
export function isAnalysisEntry(entry: MemoryEntry): entry is AnalysisMemoryEntry {
  return entry.type === "analysis";
}

/** Check if entry is a note */
export function isNoteEntry(entry: MemoryEntry): entry is NoteMemoryEntry {
  return entry.type === "note" || entry.type === "insight";
}

/** Check if entry is an error */
export function isErrorEntry(entry: MemoryEntry): entry is ErrorMemoryEntry {
  return entry.type === "error";
}

/** Check if entry has chat ID */
export function hasChatId(entry: MemoryEntry): entry is MemoryEntry & { chatId: ChatId } {
  return "chatId" in entry && entry.chatId !== undefined;
}

// =============================================================================
// RETRIEVAL OPTIONS
// =============================================================================

/** Sort order for retrieval */
export type SortOrder = "relevance" | "newest" | "oldest" | "most_accessed";

/** Base retrieval options */
interface BaseRetrievalOptions {
  /** Maximum number of results */
  readonly limit?: number;
  /** Minimum relevance score (0-1) */
  readonly minScore?: NormalizedScore;
  /** Sort order */
  readonly sortBy?: SortOrder;
  /** Filter by tags (all must match) */
  readonly tags?: string[];
  /** Filter by importance */
  readonly importance?: MemoryImportance[];
  /** Include archived entries */
  readonly includeArchived?: boolean;
  /** Time range filter */
  readonly after?: TimestampMs;
  readonly before?: TimestampMs;
  /** Whether to include embeddings */
  readonly includeEmbeddings?: boolean;
}

/** Text-based retrieval options */
export interface TextRetrievalOptions extends BaseRetrievalOptions {
  readonly mode: "text";
  /** Search query */
  readonly query: string;
  /** Use TF-IDF similarity (legacy) */
  readonly useTfIdf?: boolean;
}

/** Semantic retrieval options */
export interface SemanticRetrievalOptions extends BaseRetrievalOptions {
  readonly mode: "semantic";
  /** Search query (will be embedded) */
  readonly query: string;
  /** Pre-computed embedding */
  readonly embedding?: Vector<number>;
}

/** Hybrid retrieval options */
export interface HybridRetrievalOptions extends BaseRetrievalOptions {
  readonly mode: "hybrid";
  /** Search query */
  readonly query: string;
  /** Weight for semantic vs text (0-1) */
  readonly semanticWeight?: NormalizedScore;
}

/** Chat-specific retrieval options */
export interface ChatRetrievalOptions extends BaseRetrievalOptions {
  readonly mode: "chat";
  /** Chat ID to filter by */
  readonly chatId: ChatId;
  /** Search within chat */
  readonly query?: string;
}

/** Type-specific retrieval options */
export interface TypeRetrievalOptions extends BaseRetrievalOptions {
  readonly mode: "type";
  /** Memory types to include */
  readonly types: MemoryEntryType[];
  /** Optional search query */
  readonly query?: string;
}

/** Discriminated union of all retrieval options */
export type RetrievalOptions =
  | TextRetrievalOptions
  | SemanticRetrievalOptions
  | HybridRetrievalOptions
  | ChatRetrievalOptions
  | TypeRetrievalOptions;

// =============================================================================
// RETRIEVAL RESULTS
// =============================================================================

/** Retrieval result with score */
export interface RetrievalResult<T extends MemoryEntry = MemoryEntry> {
  /** The matched entry */
  readonly entry: T;
  /** Relevance/similarity score */
  readonly score: NormalizedScore;
  /** Why this result matched */
  readonly matchReason?: string;
  /** Matched terms (for text search) */
  readonly matchedTerms?: string[];
}

/** Paginated retrieval results */
export interface PaginatedRetrievalResult<T extends MemoryEntry = MemoryEntry> {
  /** Results for this page */
  readonly results: RetrievalResult<T>[];
  /** Total available results */
  readonly totalCount: number;
  /** Current page */
  readonly page: number;
  /** Page size */
  readonly pageSize: number;
  /** Whether there are more results */
  readonly hasMore: boolean;
  /** Next page cursor */
  readonly nextCursor?: string;
}

// =============================================================================
// MEMORY METADATA
// =============================================================================

/** Memory entry metadata */
export interface MemoryMetadata {
  /** Custom key-value pairs */
  readonly [key: string]: JsonObject | string | number | boolean | null | undefined;
}

/** Memory statistics */
export interface MemoryStats {
  /** Total entries */
  readonly totalEntries: number;
  /** Entries by type */
  readonly entriesByType: Record<MemoryEntryType, number>;
  /** Entries by importance */
  readonly entriesByImportance: Record<MemoryImportance, number>;
  /** Conversation entries count */
  readonly conversationCount: number;
  /** Note entries count */
  readonly noteCount: number;
  /** Error entries count */
  readonly errorCount: number;
  /** Archived entries count */
  readonly archivedCount: number;
  /** Has cached analysis */
  readonly hasAnalysisCache: boolean;
  /** Storage size in bytes */
  readonly storageSizeBytes: number;
  /** Last compaction time */
  readonly lastCompactedAt?: TimestampMs;
  /** Average query time */
  readonly averageQueryTimeMs: number;
}

/** Memory health status */
export interface MemoryHealth {
  readonly healthy: boolean;
  readonly issues: string[];
  readonly storageUsagePercent: number;
  readonly indexHealth: "healthy" | "degraded" | "critical";
}

// =============================================================================
// MEMORY DECAY TYPES (Phase 21)
// =============================================================================

/** Per-tier decay statistics returned by getDecayStats() */
export interface DecayTierStats {
  readonly entries: number;
  readonly avgScore: number;
  readonly atFloor: number;
  readonly lambda: number;
}

/** Aggregate decay statistics for observability */
export interface DecayStats {
  readonly enabled: boolean;
  readonly tiers: Record<string, DecayTierStats>;
  readonly exemptDomains: string[];
  readonly totalExempt: number;
}

/** Decay configuration passed from MemoryConfig.decay */
export interface MemoryDecayConfig {
  readonly enabled: boolean;
  readonly lambdas: {
    readonly working: number;
    readonly ephemeral: number;
    readonly persistent: number;
  };
  readonly exemptDomains: string[];
  readonly timeoutMs: number;
}

// =============================================================================
// MEMORY MANAGER INTERFACE
// =============================================================================

/**
 * The Memory Manager interface — persistent project knowledge and conversation memory.
 *
 * Provides three capabilities:
 *  1. **Project Cache**: Cached StradaProjectAnalysis with timestamp-based invalidation
 *  2. **Conversation Memory**: Stores conversation summaries from trimmed sessions
 *  3. **Semantic Retrieval**: Vector-based and TF-IDF text search across all stored memories
 */
export interface IMemoryManager {
  /** Initialize the memory store (load from disk) */
  initialize(): Promise<Result<void, Error>>;

  /** Shut down and flush pending writes */
  shutdown(): Promise<Result<void, Error>>;

  // --- Project Analysis Cache ---

  /** Cache a project analysis result */
  cacheAnalysis(
    analysis: StradaProjectAnalysis, 
    projectPath: string,
    options?: { ttl?: DurationMs }
  ): Promise<Result<void, Error>>;

  /** Get cached analysis if still valid (not older than maxAgeMs) */
  getCachedAnalysis(
    projectPath: string, 
    maxAgeMs?: DurationMs
  ): Promise<Result<Option<StradaProjectAnalysis>, Error>>;

  /** Invalidate cached analysis */
  invalidateAnalysis(projectPath: string): Promise<Result<void, Error>>;

  // --- Conversation Memory ---

  /** Store a conversation summary from trimmed messages */
  storeConversation(
    chatId: ChatId, 
    summary: string, 
    options?: {
      tags?: string[];
      importance?: MemoryImportance;
      turnNumber?: number;
      userMessage?: string;
      assistantMessage?: string;
    }
  ): Promise<Result<MemoryId, Error>>;

  /** Get conversation history for a chat */
  getChatHistory(
    chatId: ChatId, 
    options?: { limit?: number; before?: TimestampMs }
  ): Promise<Result<ConversationMemoryEntry[], Error>>;

  // --- General Memory Storage ---

  /** Store a general note or insight */
  storeNote(
    content: string, 
    options?: {
      title?: string;
      tags?: string[];
      importance?: MemoryImportance;
      source?: string;
      metadata?: MemoryMetadata;
    }
  ): Promise<Result<MemoryId, Error>>;

  /** Store an error with context */
  storeError(
    error: Error,
    context: {
      category: string;
      location?: string;
      chatId?: ChatId;
    },
    options?: {
      tags?: string[];
      metadata?: MemoryMetadata;
    }
  ): Promise<Result<MemoryId, Error>>;

  /** Mark error as resolved */
  resolveError(
    id: MemoryId, 
    resolution: string
  ): Promise<Result<void, Error>>;

  /** Store a memory entry directly */
  storeEntry<T extends MemoryEntry>(
    entry: Omit<T, "id" | "createdAt" | "accessCount">
  ): Promise<Result<T, Error>>;

  /** Get entry by ID */
  getEntry<T extends MemoryEntry>(id: MemoryId): Promise<Result<Option<T>, Error>>;

  /** Update entry */
  updateEntry<T extends MemoryEntry>(
    id: MemoryId,
    updates: Partial<Omit<T, "id" | "createdAt">>
  ): Promise<Result<T, Error>>;

  /** Delete entry */
  deleteEntry(id: MemoryId): Promise<Result<boolean, Error>>;

  // --- Retrieval ---

  /** Search memory */
  retrieve(
    options: RetrievalOptions
  ): Promise<Result<RetrievalResult[], Error>>;

  /** Search with pagination */
  retrievePaginated(
    options: RetrievalOptions,
    pagination: { page: number; pageSize: number; cursor?: string }
  ): Promise<Result<PaginatedRetrievalResult, Error>>;

  /** Semantic search with embedding */
  retrieveSemantic(
    query: string,
    options?: Omit<SemanticRetrievalOptions, "mode" | "query">
  ): Promise<Result<RetrievalResult[], Error>>;

  /** Search within a specific chat */
  retrieveFromChat(
    chatId: ChatId,
    options?: Omit<ChatRetrievalOptions, "mode" | "chatId">
  ): Promise<Result<RetrievalResult<ConversationMemoryEntry>[], Error>>;

  // --- Management ---

  /** Archive old entries */
  archiveOldEntries(before: TimestampMs): Promise<Result<number, Error>>;

  /** Compact and optimize storage */
  compact(): Promise<Result<{ freedBytes: number }, Error>>;

  /** Get memory usage statistics */
  getStats(): MemoryStats;

  /** Get health status */
  getHealth(): MemoryHealth;

  /** Get per-tier decay statistics for observability (optional, implemented by AgentDBMemory) */
  getDecayStats?(): DecayStats;

  /** Export memory to JSON */
  export(options?: { 
    types?: MemoryEntryType[]; 
    after?: TimestampMs; 
    before?: TimestampMs;
  }): Promise<Result<JsonObject, Error>>;

  /** Import memory from JSON */
  import(data: JsonObject): Promise<Result<number, Error>>;
}

// =============================================================================
// MEMORY CONFIGURATION
// =============================================================================

/** Memory manager configuration */
export interface MemoryConfig {
  /** Storage path */
  readonly dbPath: string;
  /** Maximum entries before compaction */
  readonly maxEntries: number;
  /** Default TTL for entries (0 = no TTL) */
  readonly defaultTtl: DurationMs;
  /** Whether to enable embeddings */
  readonly enableEmbeddings: boolean;
  /** Embedding dimensions */
  readonly embeddingDimensions?: number;
  /** Auto-archive entries older than this (0 = disabled) */
  readonly autoArchiveAfter?: DurationMs;
  /** Storage quota in bytes (0 = unlimited) */
  readonly storageQuotaBytes: number;
  /** Write-ahead logging enabled */
  readonly walEnabled: boolean;
  /** Synchronous mode */
  readonly synchronous: "full" | "normal" | "off";
}

/** Default memory configuration */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  dbPath: ".strada-memory",
  maxEntries: 10000,
  defaultTtl: 0 as DurationMs,
  enableEmbeddings: true,
  embeddingDimensions: 1536,
  storageQuotaBytes: 0,
  walEnabled: true,
  synchronous: "normal",
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get importance numeric value for comparison
 */
export function getImportanceValue(importance: MemoryImportance): number {
  const values: Record<MemoryImportance, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  return values[importance];
}

/**
 * Compare importance levels
 */
export function isMoreImportant(a: MemoryImportance, b: MemoryImportance): boolean {
  return getImportanceValue(a) > getImportanceValue(b);
}

/**
 * Create a memory ID
 */
export function createMemoryId(): MemoryId {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` as MemoryId;
}

/**
 * Calculate memory importance based on content analysis
 */
export function calculateImportance(content: string): MemoryImportance {
  // Simple heuristic based on content indicators
  const indicators = {
    critical: /\b(error|exception|crash|critical|urgent|emergency)\b/gi,
    high: /\b(warning|important|todo|fixme|hack|bug)\b/gi,
    medium: /\b(note|info|suggestion|improvement)\b/gi,
  };
  
  if (indicators.critical.test(content)) return "critical";
  if (indicators.high.test(content)) return "high";
  if (indicators.medium.test(content)) return "medium";
  return "low";
}

/**
 * Filter entries by type
 */
export function filterByType<T extends MemoryEntryType>(
  entries: MemoryEntry[],
  type: T
): Extract<MemoryEntry, { type: T }>[] {
  return entries.filter((e): e is Extract<MemoryEntry, { type: T }> => e.type === type);
}

/**
 * Sort entries by recency
 */
export function sortByRecency<T extends { createdAt: TimestampMs }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Sort entries by relevance score
 */
export function sortByScore<T extends { score: NormalizedScore }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.score - a.score);
}
