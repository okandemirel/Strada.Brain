/**
 * AgentDB Unified Memory Implementation
 *
 * Integrates AgentDB with HNSW indexing for 150x-12,500x performance improvement
 * Implements 3-tier memory architecture (Working, Ephemeral, Persistent)
 *
 * Delegates to helper modules:
 *   - agentdb-sqlite.ts  — SQLite persistence
 *   - agentdb-vector.ts  — HNSW / embedding operations
 *   - agentdb-tiering.ts — auto-tiering, decay, importance scoring
 *   - agentdb-retrieval.ts — semantic, hybrid, MMR retrieval
 *   - agentdb-time.ts    — shared clock utility
 */

import { existsSync, mkdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  IUnifiedMemory,
  UnifiedMemoryEntry,
  UnifiedMemoryQuery,
  UnifiedMemoryStats,
  MigrationStatus,
  UnifiedMemoryConfig,
  HnswHealth,
} from "./unified-memory.interface.js";
import { MemoryTier, DEFAULT_MEMORY_CONFIG } from "./unified-memory.interface.js";
import type { RetrievalOptions, RetrievalResult, MemoryOwnershipOptions } from "../memory.interface.js";
import type { StradaProjectAnalysis } from "../../intelligence/strada-analyzer.js";
import { getLogger } from "../../utils/logger.js";
import type { HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import type { VectorEntry } from "../../rag/rag.interface.js";
import { TextIndex, extractTerms } from "../text-index.js";
import type {
  Result,
  Option,
  MemoryId,
  ChatId,
  TimestampMs,
  DurationMs,
  NormalizedScore,
  Vector,
} from "../../types/index.js";
import { ok, err, some, none, createBrand } from "../../types/index.js";
import { HnswWriteMutex } from "./hnsw-write-mutex.js";
import { UserProfileStore } from "./user-profile-store.js";
import { TaskExecutionStore } from "./task-execution-store.js";
import type { DecayStats, DecayTierStats, MemoryDecayConfig } from "../memory.interface.js";
export type { MemoryDecayConfig } from "../memory.interface.js";

// --- Helper module imports ---
import {
  initSqlite,
  closeSqlite,
  persistEntry as sqlitePersistEntry,
  removePersistedEntry as sqliteRemovePersistedEntry,
  saveAllEntries,
  bufferToEmbedding,
  type AgentDBSqliteContext,
  type MemoryRow,
  type PatternRow,
} from "./agentdb-sqlite.js";

import {
  toVectorEntry,
  embedWithProvenance,
  canEnterIndex,
  countEntriesNeedingReEmbedding,
  indexProvenance,
  inferProvenance,
  isHashBasedEmbedding,
  openAgentDbHnswStore,
  providerProvenance,
  rebuildHnswIndex,
  reEmbedHashEntries,
  type ReEmbedOptions,
  type ReEmbedResult,
} from "./agentdb-vector.js";

import {
  calculateImportanceScore,
  enforceTierLimits as enforceTierLimitsHelper,
  autoTieringSweep as autoTieringSweepHelper,
} from "./agentdb-tiering.js";

import {
  retrieveTFIDF,
  retrieveSemantic as retrieveSemanticHelper,
  retrieveHybrid as retrieveHybridHelper,
} from "./agentdb-retrieval.js";

import { getNow, _setNowFn, _resetNowFn } from "./agentdb-time.js";
import { sanitizeSecretsDeep } from "../../security/secret-sanitizer.js";
import { redactSecrets, stringifyRedacted } from "../../security/secret-patterns.js";

/**
 * Ownership fields for a note-storing API (Codex round 7 #19). Only the keys
 * the caller set are written, so an entry with no ownership stays exactly as
 * before (chatId "default", unknown ownership, not shared).
 */
function ownershipFields(ownership: MemoryOwnershipOptions | undefined): {
  chatId?: ChatId;
  userId?: string;
  projectId?: string;
  shared?: true;
} {
  if (!ownership) return {};
  return {
    ...(ownership.chatId !== undefined ? { chatId: ownership.chatId } : {}),
    ...(ownership.userId !== undefined ? { userId: ownership.userId } : {}),
    ...(ownership.projectId !== undefined ? { projectId: ownership.projectId } : {}),
    ...(ownership.shared === true ? { shared: true as const } : {}),
  };
}

/** Identity supplied through metadata by callers that cannot set top-level fields (plan 3.9). */
function readIdentity(metadata: unknown, key: "userId" | "projectId"): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Top-level fields persistEntry writes back verbatim: identity and
 * classification, never caller free text (and an altered id would write a
 * different row).
 */
const PERSIST_UNREDACTED_FIELDS = new Set([
  "id", "type", "content", "chatId", "userId", "projectId", "domain", "embeddingProvenance", "tier", "importance",
]);

// Re-export clock utilities for test compatibility
export { _setNowFn, _resetNowFn };

// ---------------------------------------------------------------------------
// Logger helper
// ---------------------------------------------------------------------------

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

// ---------------------------------------------------------------------------
// Metadata sanitization — delegates to the shared `sanitizeSecretsDeep` helper
// in secret-sanitizer.ts so every memory-write path uses the same policy.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AgentDBMemory Class
// ---------------------------------------------------------------------------

/**
 * AgentDB Memory Manager
 *
 * Provides unified memory with:
 * - HNSW vector indexing for semantic search
 * - 3-tier memory organization
 * - Backward compatibility with TF-IDF
 * - Automatic tier management
 */
export class AgentDBMemory implements IUnifiedMemory {
  private config: UnifiedMemoryConfig;
  private dbPath: string;
  private entries: Map<string, UnifiedMemoryEntry> = new Map();
  private hnswStore?: HNSWVectorStore;
  private readonly writeMutex = new HnswWriteMutex();
  private textIndex = new TextIndex();
  private cachedAnalysis: { projectPath: string; analysis: StradaProjectAnalysis } | null = null;
  private migrationStatus: MigrationStatus;
  private isInitialized = false;
  private searchTimes: number[] = [];
  private tieringTimer: ReturnType<typeof setInterval> | null = null;
  private tieringParams: { intervalMs: number; promotionThreshold: number; demotionTimeoutDays: number } | null = null;
  private sqliteDb: Database.Database | null = null;
  private sqliteInitFailed = false;
  /** memory.db failed integrity_check and REINDEX did not repair it (set by initSqlite). */
  private sqliteIntegrityFailed = false;
  private sqliteStatements: Map<string, Database.Statement> = new Map();
  private decayConfig: MemoryDecayConfig | null = null;
  private userProfileStore: UserProfileStore | null = null;
  private taskExecutionStore: TaskExecutionStore | null = null;
  private rebuildInProgress = false;
  /** Rebuild of the index for a new embedding size, while it runs (shutdown waits for it). */
  private sizeRebuild: Promise<void> | null = null;
  /** Re-embed passes in flight: shutdown stops each at its next batch and waits for it. */
  private readonly reEmbedPasses = new Set<Promise<ReEmbedResult>>();
  private shuttingDown = false;
  /** The ignored caller-supplied query vector warning was logged (once per memory, not per search). */
  private callerVectorWarned = false;
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(config: Partial<UnifiedMemoryConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    this.dbPath = this.config.dbPath;
    this.migrationStatus = {
      version: 1,
      isComplete: false,
      sourceSystem: "unknown",
      entriesMigrated: 0,
      entriesFailed: 0,
      startedAt: getNow(),
      errors: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Context builders for helper delegation
  //
  // These use property descriptors so that mutable primitive fields (sqliteDb,
  // sqliteInitFailed, hnswStore, rebuildInProgress, etc.) read/write through
  // to `this`, avoiding stale-copy bugs with plain object spreads.
  // ---------------------------------------------------------------------------

  /** Build the SQLite context from private fields (read-through / write-through). */
  private getSqliteCtx(): AgentDBSqliteContext {
     
    const self = this;
    return {
      get dbPath() { return self.dbPath; },
      get sqliteDb() { return self.sqliteDb; },
      set sqliteDb(v) { self.sqliteDb = v; },
      get sqliteInitFailed() { return self.sqliteInitFailed; },
      set sqliteInitFailed(v) { self.sqliteInitFailed = v; },
      get sqliteIntegrityFailed() { return self.sqliteIntegrityFailed; },
      set sqliteIntegrityFailed(v: boolean | undefined) { self.sqliteIntegrityFailed = v === true; },
      get sqliteStatements() { return self.sqliteStatements; },
      get entries() { return self.entries; },
    };
  }

  /** Build the vector context from private fields. */
  private getVectorCtx() {
     
    const self = this;
    return {
      get dbPath() { return self.dbPath; },
      get sqliteDb() { return self.sqliteDb; },
      set sqliteDb(v) { self.sqliteDb = v; },
      get sqliteInitFailed() { return self.sqliteInitFailed; },
      set sqliteInitFailed(v: boolean) { self.sqliteInitFailed = v; },
      get sqliteStatements() { return self.sqliteStatements; },
      get entries() { return self.entries; },
      get config() { return self.config; },
      get hnswStore() { return self.hnswStore; },
      set hnswStore(v) { self.hnswStore = v; },
      get writeMutex() { return self.writeMutex; },
      get rebuildInProgress() { return self.rebuildInProgress; },
      set rebuildInProgress(v) { self.rebuildInProgress = v; },
      get tieringTimer() { return self.tieringTimer; },
      set tieringTimer(v) { self.tieringTimer = v; },
      get tieringParams() { return self.tieringParams; },
      set tieringParams(v) { self.tieringParams = v; },
      startAutoTiering: self.startAutoTiering.bind(self),
      stopAutoTiering: self.stopAutoTiering.bind(self),
    };
  }

  /** Build the tiering context from private fields. */
  private getTieringCtx() {
     
    const self = this;
    return {
      get dbPath() { return self.dbPath; },
      get sqliteDb() { return self.sqliteDb; },
      set sqliteDb(v) { self.sqliteDb = v; },
      get sqliteInitFailed() { return self.sqliteInitFailed; },
      set sqliteInitFailed(v: boolean) { self.sqliteInitFailed = v; },
      get sqliteStatements() { return self.sqliteStatements; },
      get entries() { return self.entries; },
      get config() { return self.config; },
      get hnswStore() { return self.hnswStore; },
      get writeMutex() { return self.writeMutex; },
      get decayConfig() { return self.decayConfig; },
      get textIndex() { return self.textIndex; },
      promoteEntry: self.promoteEntry.bind(self),
      demoteEntry: self.demoteEntry.bind(self),
      // Wire through the class method so vi.spyOn intercepts calls
      enforceTierLimitsOverride: (tier: MemoryTier) => self.enforceTierLimits(tier),
    };
  }

  /** Build the retrieval context from private fields. */
  private getRetrievalCtx() {
     
    const self = this;
    return {
      get config() { return self.config; },
      get entries() { return self.entries; },
      get hnswStore() { return self.hnswStore; },
      get textIndex() { return self.textIndex; },
      get searchTimes() { return self.searchTimes; },
      sqlitePersistEntry: (entry: UnifiedMemoryEntry) => sqlitePersistEntry(self.getSqliteCtx(), entry),
      onQueryVectorMismatch: (source: "caller" | "provider", dimensions: number) =>
        self.onQueryVectorMismatch(source, dimensions),
    };
  }

  // ---------------------------------------------------------------------------
  // Embedding size changes
  // ---------------------------------------------------------------------------

  private onQueryVectorMismatch(source: "caller" | "provider", dimensions: number): void {
    if (source === "provider") {
      this.adoptEmbeddingSize(dimensions);
      return;
    }
    if (this.callerVectorWarned) return;
    this.callerVectorWarned = true;
    getLoggerSafe().warn(
      "[AgentDBMemory] Ignoring caller-supplied query vectors that do not fit this memory's index; queries are embedded with the memory's own embedder",
      {
        dbPath: this.dbPath,
        callerDimensions: dimensions,
        indexDimensions: this.config.dimensions,
        indexProvenance: indexProvenance(this.config),
      },
    );
  }

  /**
   * The embedding provider answered at a size the index was not built for: it
   * returns another size than it declared, or its model changed under it.
   * Vectors of two sizes cannot share one index, and leaving it at the old
   * size kept every new entry out of it and failed every search. Adopt the new
   * size and rebuild the index for it in the background — rebuildHnswIndex
   * resets the store in place and re-embeds every entry; until it finishes,
   * rows the index cannot serve yet are found through text. Logged once per
   * change.
   */
  private adoptEmbeddingSize(dimensions: number): void {
    if (!this.config.embeddingProvider || this.rebuildInProgress) return;
    if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions === this.config.dimensions) return;
    getLoggerSafe().warn(
      `[AgentDBMemory] Embedding size changed from ${this.config.dimensions} to ${dimensions}; rebuilding the memory index for the new size`,
      { dbPath: this.dbPath, entries: this.entries.size },
    );
    this.config = { ...this.config, dimensions };
    this.sizeRebuild = rebuildHnswIndex(this.getVectorCtx())
      .catch((error: unknown) => {
        getLoggerSafe().error("[AgentDBMemory] Rebuilding the memory index for the new embedding size failed", {
          dbPath: this.dbPath,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.sizeRebuild = null;
      });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<Result<void, Error>> {
    try {
      if (this.isInitialized) return ok(undefined);
      this.shuttingDown = false;

      getLoggerSafe().info("[AgentDBMemory] Initializing unified memory", {
        dbPath: this.dbPath,
        dimensions: this.config.dimensions,
      });

      // Create directories
      if (!existsSync(this.dbPath)) {
        mkdirSync(this.dbPath, { recursive: true });
      }

      // Initialize SQLite persistence (writes through to this.sqliteDb via proxy)
      initSqlite(this.getSqliteCtx());

      if (this.sqliteInitFailed && !this.sqliteDb) {
        getLoggerSafe().warn(
          "[AgentDBMemory] Running in degraded mode — SQLite persistence unavailable",
        );
      }

      // Initialize user profile store (shares SQLite DB)
      if (this.sqliteDb) {
        this.userProfileStore = new UserProfileStore(this.sqliteDb);
        this.taskExecutionStore = new TaskExecutionStore(this.sqliteDb);
      }

      // Initialize HNSW vector store. A persisted index that no longer fits
      // the config (e.g. other embedding dimensions) is discarded while
      // opening; loadEntries rebuilds the index from SQLite either way.
      this.hnswStore = await openAgentDbHnswStore(this.dbPath, this.config);
      // Gate the store's background compaction rebuild behind the same write mutex
      // that serializes all other HNSW writes (M1). Optional: this is best-effort
      // wiring of an optimization, so a store implementation/mock that lacks the
      // method must not abort initialize().
      this.hnswStore.setWriteSerializer?.(this.writeMutex);

      // Load existing entries from AgentDB-style storage
      await this.loadEntries();

      this.isInitialized = true;

      getLoggerSafe().info("[AgentDBMemory] Initialization complete", {
        entries: this.entries.size,
        hnswElements: this.hnswStore?.count() ?? 0,
      });

      return ok(undefined);
    } catch (error) {
      // Release what this attempt opened: the caller falls back to another
      // backend, and a leaked handle keeps memory.db attached for the life of
      // the process (restores then refuse to swap it).
      this.hnswStore = undefined;
      this.userProfileStore = null;
      this.taskExecutionStore = null;
      closeSqlite(this.getSqliteCtx());
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async shutdown(): Promise<Result<void, Error>> {
    try {
      if (!this.isInitialized) return ok(undefined);

      getLoggerSafe().info("[AgentDBMemory] Shutting down");
      this.shuttingDown = true;

      // A rebuild for a new embedding size writes SQLite and the index and
      // restarts auto-tiering when done; let it finish before closing them.
      if (this.sizeRebuild) await this.sizeRebuild;
      // A re-embed pass writes both too: with shuttingDown set it stops at
      // its next batch (the rest resumes on the next open); wait for that.
      if (this.reEmbedPasses.size > 0) await Promise.allSettled([...this.reEmbedPasses]);

      // Stop auto-tiering timer before saving to prevent sweep during shutdown
      this.stopAutoTiering();

      // Save entries
      await this.saveEntries();

      // Shutdown HNSW store
      if (this.hnswStore) {
        await this.hnswStore.shutdown();
      }

      // Close SQLite (writes through to this.sqliteDb via proxy)
      closeSqlite(this.getSqliteCtx());

      this.isInitialized = false;
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---------------------------------------------------------------------------
  // User Profile Store
  // ---------------------------------------------------------------------------

  getUserProfileStore(): UserProfileStore | null {
    return this.userProfileStore;
  }

  getTaskExecutionStore(): TaskExecutionStore | null {
    return this.taskExecutionStore;
  }

  // ---------------------------------------------------------------------------
  // Decay Configuration
  // ---------------------------------------------------------------------------

  /** Configure memory decay parameters. Called by bootstrap after config load. */
  setDecayConfig(config: MemoryDecayConfig): void {
    this.decayConfig = config;
  }

  /**
   * Get per-tier decay statistics for observability.
   * Returns entry counts, average importance scores, at-floor counts, and lambda values.
   */
  getDecayStats(): DecayStats {
    const enabled = this.decayConfig?.enabled ?? false;
    const lambdas = this.decayConfig?.lambdas ?? { working: 0, ephemeral: 0, persistent: 0 };
    const exemptDomains = this.decayConfig?.exemptDomains ?? [];

    const tierAccumulators: Record<string, { entries: number; totalScore: number; atFloor: number; lambda: number }> = {
      [MemoryTier.Working]: { entries: 0, totalScore: 0, atFloor: 0, lambda: lambdas.working },
      [MemoryTier.Ephemeral]: { entries: 0, totalScore: 0, atFloor: 0, lambda: lambdas.ephemeral },
      [MemoryTier.Persistent]: { entries: 0, totalScore: 0, atFloor: 0, lambda: lambdas.persistent },
    };

    let totalExempt = 0;

    for (const entry of this.entries.values()) {
      if (entry.domain && exemptDomains.includes(entry.domain)) {
        totalExempt++;
        continue;
      }
      const acc = tierAccumulators[entry.tier];
      if (!acc) continue;
      acc.entries++;
      acc.totalScore += entry.importanceScore;
      if (entry.importanceScore <= 0.01) {
        acc.atFloor++;
      }
    }

    const tiers: Record<string, DecayTierStats> = {};
    for (const [tier, acc] of Object.entries(tierAccumulators)) {
      tiers[tier] = {
        entries: acc.entries,
        avgScore: acc.entries > 0 ? acc.totalScore / acc.entries : 0,
        atFloor: acc.atFloor,
        lambda: acc.lambda,
      };
    }

    return { enabled, tiers, exemptDomains, totalExempt };
  }

  // ---------------------------------------------------------------------------
  // Auto-Tiering
  // ---------------------------------------------------------------------------

  startAutoTiering(intervalMs: number, promotionThreshold: number, demotionTimeoutDays: number): void {
    if (this.tieringTimer) return;
    this.tieringParams = { intervalMs, promotionThreshold, demotionTimeoutDays };
    this.tieringTimer = setInterval(
      () => this.autoTieringSweep(promotionThreshold, demotionTimeoutDays)
        .catch(e => getLoggerSafe().error("[AgentDBMemory] Auto-tiering sweep failed", { error: String(e) }))
        // Expired-entry cleanup rides the same cadence: nothing else scheduled it,
        // so expired Ephemeral rows used to accumulate forever (Map + SQLite + HNSW).
        .then(() => this.cleanupExpired())
        .catch(e => getLoggerSafe().error("[AgentDBMemory] Expired-entry cleanup failed", { error: String(e) })),
      intervalMs,
    );
    this.tieringTimer.unref();
  }

  stopAutoTiering(): void {
    if (this.tieringTimer) {
      clearInterval(this.tieringTimer);
      this.tieringTimer = null;
    }
  }

  /**
   * Private delegate — kept as an instance method so tests that cast through
   * `(memory as any).autoTieringSweep(...)` continue to work.
   */
  private async autoTieringSweep(promotionThreshold: number, demotionTimeoutDays: number): Promise<void> {
    return autoTieringSweepHelper(this.getTieringCtx(), promotionThreshold, demotionTimeoutDays);
  }

  /**
   * Private delegate — kept as an instance method so tests that spy on
   * `(memory as any).enforceTierLimits(...)` continue to work.
   */
  private async enforceTierLimits(tier: MemoryTier): Promise<void> {
    return enforceTierLimitsHelper(this.getTieringCtx(), tier);
  }

  /**
   * Private delegate — kept as an instance method so tests that cast through
   * `(memory as any).isHashBasedEmbedding(...)` continue to work.
   * @internal accessed via `(this as any)` in test code
   */
  // @ts-expect-error TS6133 — accessed at runtime by tests via (memory as any).isHashBasedEmbedding
  private isHashBasedEmbedding(content: string, embedding: number[]): boolean {
    return isHashBasedEmbedding(content, embedding);
  }

  // ---------------------------------------------------------------------------
  // Project Analysis Cache
  // ---------------------------------------------------------------------------

  async cacheAnalysis(
    analysis: StradaProjectAnalysis,
    projectPath: string,
  ): Promise<Result<void, Error>> {
    try {
      this.cachedAnalysis = { projectPath, analysis };

      // Also store in persistent memory for long-term retention. A project
      // analysis is global by nature — every chat may recall it — so it is
      // written `shared: true` explicitly (Codex round 7 #19); a row without
      // the flag is of unknown ownership and stays out of chat-scoped recall.
      const storeResult = await this.storeEntry({
        type: "analysis",
        content: JSON.stringify(analysis),
        tags: ["project-analysis", "cached"],
        importance: "high",
        archived: false,
        metadata: { projectPath },
        // No embedding passed: storeEntry embeds the redacted text (MEM-21).
        tier: MemoryTier.Persistent,
        importanceScore: createBrand(0.9, "NormalizedScore" as const),
        domain: "analysis-cache",
        shared: true,
      } as unknown as Omit<
        UnifiedMemoryEntry,
        "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version"
      >);

      if (storeResult.kind === "err") {
        return storeResult;
      }

      getLoggerSafe().debug("[AgentDBMemory] Cached project analysis", { projectPath });
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getCachedAnalysis(
    projectPath: string,
    maxAgeMs: DurationMs = createBrand(24 * 60 * 60 * 1000, "DurationMs" as const),
  ): Promise<StradaProjectAnalysis | null> {
    if (!this.cachedAnalysis) {
      this.cacheMisses++;
      return null;
    }
    if (this.cachedAnalysis.projectPath !== projectPath) {
      this.cacheMisses++;
      return null;
    }

    const age = Date.now() - this.cachedAnalysis.analysis.analyzedAt.getTime();
    if (age > maxAgeMs) {
      this.cacheMisses++;
      return null;
    }

    this.cacheHits++;
    return this.cachedAnalysis.analysis;
  }

  // ---------------------------------------------------------------------------
  // Conversation Memory
  // ---------------------------------------------------------------------------

  async storeConversation(
    chatId: ChatId,
    summary: string,
    tags: string[] = [],
    tier: MemoryTier = MemoryTier.Ephemeral,
    options?: { userMessage?: string; assistantMessage?: string },
  ): Promise<import("../memory.interface.js").MemoryEntry> {
    const result = await this.storeEntry({
      type: "conversation",
      content: summary,
      tags: [...tags, "conversation"],
      importance: "medium",
      archived: false,
      metadata: {
        ...(options?.userMessage ? { userMessage: options.userMessage } : {}),
        ...(options?.assistantMessage ? { assistantMessage: options.assistantMessage } : {}),
      },
      // No embedding passed: storeEntry embeds the redacted text (MEM-21).
      tier,
      importanceScore: calculateImportanceScore(summary, tier),
      chatId,
    } as unknown as Omit<
      UnifiedMemoryEntry,
      "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version"
    >);

    if (result.kind === "err") {
      throw result.error;
    }

    return result.value;
  }

  async storeNote(
    content: string,
    tags: string[] = [],
    tier: MemoryTier = MemoryTier.Persistent,
    ownership?: MemoryOwnershipOptions,
  ): Promise<import("../memory.interface.js").MemoryEntry> {
    // Codex round 7 #19: the note used to carry no chatId, so it was of
    // unknown ownership and never returned to a chat-scoped recall.
    const result = await this.storeEntry({
      type: "note",
      content,
      tags: [...tags, "note"],
      importance: "medium",
      archived: false,
      metadata: {},
      // No embedding passed: storeEntry embeds the redacted text (MEM-21).
      tier,
      importanceScore: calculateImportanceScore(content, tier),
      ...ownershipFields(ownership),
    } as unknown as Omit<
      UnifiedMemoryEntry,
      "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version"
    >);

    if (result.kind === "err") {
      throw result.error;
    }

    return result.value;
  }

  async storeEntry(
    entry: Omit<
      UnifiedMemoryEntry,
      "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version"
    >,
  ): Promise<Result<import("../memory.interface.js").MemoryEntry, Error>> {
    try {
      if (!this.isInitialized) {
        return err(new Error("AgentDBMemory not initialized"));
      }

      // Security: sanitize free-form text BEFORE embedding / indexing / storage.
      // This ensures the in-memory cache, HNSW embeddings, text index, and
      // SQLite all hold redacted content. IDs, tier, and metadata keys pass through.
      // agentdb-sqlite.upsertEntryRow relies on this — it does NOT re-sanitize.
      // Redacted without the display-length cap: this is the stored text (SEC-3).
      const sanitizedContent = typeof entry.content === "string"
        ? redactSecrets(entry.content)
        : entry.content;
      const sanitizedMetadata = entry.metadata
        ? sanitizeSecretsDeep(entry.metadata)
        : entry.metadata;
      entry = { ...entry, content: sanitizedContent, metadata: sanitizedMetadata };

      const id = createBrand(randomUUID(), "MemoryId" as const);
      const now = getNow();

      // Generate embedding if not provided — and record which embedder made it
      // (plan 0-B.9). A caller-supplied vector without provenance is classified
      // by shape (legacy path); the histogram fallback is stamped "histogram".
      let embedding: Vector<number>;
      let embeddingProvenance: string | undefined;
      if (entry.embedding) {
        embedding = entry.embedding;
        embeddingProvenance = entry.embeddingProvenance ?? inferProvenance(this.config, entry.embedding);
      } else {
        const embedded = await embedWithProvenance(this.config, entry.content);
        embedding = embedded.embedding;
        embeddingProvenance = embedded.provenance;
        // The provider answered at another size than the index's: adopt it
        // (the index is rebuilt) so this entry and the next ones are indexed.
        if (embeddingProvenance === providerProvenance(this.config) && embedding.length !== this.config.dimensions) {
          this.adoptEmbeddingSize(embedding.length);
        }
      }

      // Determine expiration for ephemeral entries
      let expiresAt: TimestampMs | undefined;
      if (entry.tier === MemoryTier.Ephemeral) {
        expiresAt = createBrand(Date.now() + this.config.ephemeralTtlMs, "TimestampMs" as const);
      }

      // Build unified entry based on type
      const baseEntry = {
        id,
        type: entry.type,
        content: entry.content,
        createdAt: now,
        tags: entry.tags,
        importance: entry.importance,
        archived: entry.archived,
        metadata: entry.metadata,
        embedding,
        embeddingProvenance,
        tier: entry.tier,
        accessCount: 0,
        lastAccessedAt: now,
        expiresAt,
        hnswIndex: this.hnswStore?.count() ?? 0,
        version: 1,
        importanceScore: entry.importanceScore,
        domain: entry.domain,
        chatId: entry.chatId ?? createBrand("default", "ChatId" as const),
        // plan 3.9: identity scope — top-level or metadata-supplied
        userId: entry.userId ?? readIdentity(entry.metadata, "userId"),
        projectId: entry.projectId ?? readIdentity(entry.metadata, "projectId"),
        // Codex round 6 #16: an explicit share is a deliberate write
        shared: entry.shared === true || entry.metadata?.["shared"] === true ? true : undefined,
      };

      // Type-specific fields
      let unifiedEntry: UnifiedMemoryEntry;
      if (entry.type === "conversation") {
        unifiedEntry = {
          ...baseEntry,
          type: "conversation",
          userMessage: entry.content,
        } as unknown as UnifiedMemoryEntry;
      } else if (entry.type === "note" || entry.type === "insight") {
        unifiedEntry = {
          ...baseEntry,
          type: entry.type,
          source: "user",
        } as unknown as UnifiedMemoryEntry;
      } else if (entry.type === "analysis") {
        unifiedEntry = {
          ...baseEntry,
          type: "analysis",
          projectPath: entry.domain ?? "unknown",
          category: "structure",
          analysisVersion: "1.0",
        } as unknown as UnifiedMemoryEntry;
      } else if (entry.type === "error") {
        unifiedEntry = {
          ...baseEntry,
          type: "error",
          errorCategory: "general",
          resolved: false,
        } as unknown as UnifiedMemoryEntry;
      } else if (entry.type === "command") {
        unifiedEntry = {
          ...baseEntry,
          type: "command",
          command: entry.content,
          workingDirectory: ".",
          exitCode: 0,
          success: true,
        } as unknown as UnifiedMemoryEntry;
      } else if (entry.type === "task") {
        unifiedEntry = {
          ...baseEntry,
          type: "task",
          task: entry.content,
          status: "pending",
        } as unknown as UnifiedMemoryEntry;
      } else if (entry.type === "project") {
        unifiedEntry = {
          ...baseEntry,
          type: "project",
          projectId: baseEntry.projectId ?? entry.domain ?? "unknown",
          source: "source" in entry ? (entry as { source?: string }).source : undefined,
        } as unknown as UnifiedMemoryEntry;
      } else {
        unifiedEntry = baseEntry as unknown as UnifiedMemoryEntry;
      }

      // Add to HNSW index (mutex-serialized to prevent interleaved writes).
      // Provenance gate (plan 0-B.9): only a vector of the index's provenance
      // enters it. A histogram written during a provider outage stays on the
      // row and is served by the text path only.
      let hnswInserted = false;
      if (this.hnswStore && embedding.length === this.config.dimensions
        && !canEnterIndex(this.config, { embedding, embeddingProvenance })) {
        getLoggerSafe().warn(
          "[AgentDBMemory] Vector kept out of HNSW index — provenance differs from index",
          { id: id as string, embeddingProvenance, indexProvenance: indexProvenance(this.config) },
        );
      } else if (this.hnswStore && embedding.length === this.config.dimensions) {
        const store = this.hnswStore;
        const vectorEntry = toVectorEntry({
          id: id as string,
          content: entry.content,
          chatId: entry.chatId as string | undefined,
          embedding,
          createdAt: Date.now(),
          accessCount: 0,
        });
        try {
          await this.writeMutex.withLock(() => store.upsert([vectorEntry]));
          hnswInserted = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("exceeds the specified limit") || message.includes("Index capacity exceeded")) {
            getLoggerSafe().warn(
              "[AgentDBMemory] HNSW index capacity mismatch detected, rebuilding index",
              { error: message, entryId: id as string },
            );
            // The rebuild reads this.entries, which does not contain this
            // entry yet (it is only added after SQLite succeeds). It used to
            // rebuild without the pending vector and fall through to ok(),
            // leaving the entry in SQLite/map/TF-IDF but absent from HNSW
            // until the next rebuild. Pass the pending vector so the rebuilt
            // index contains it (audited 2026-09-02).
            const rebuildResult = await this.rebuildIndex([vectorEntry]);
            if (rebuildResult.kind === "err") {
              return err(rebuildResult.error);
            }
            hnswInserted = true;
          } else {
            throw error;
          }
        }
      } else if (this.hnswStore && embedding.length !== this.config.dimensions) {
        getLoggerSafe().warn(
          `[AgentDB] Skipping entry with mismatched dimensions (got ${embedding.length}, expected ${this.config.dimensions})`,
          { id: id as string },
        );
      }

      // Persist to SQLite
      try {
        sqlitePersistEntry(this.getSqliteCtx(), unifiedEntry);
      } catch (error) {
        if (hnswInserted && this.hnswStore) {
          const store = this.hnswStore;
          await this.writeMutex.withLock(() => store.remove([id as string]));
        }
        return err(error instanceof Error ? error : new Error(String(error)));
      }

      // Update in-memory indexes only after persistent stores succeed
      this.entries.set(id as string, unifiedEntry);
      const terms = extractTerms(entry.content);
      this.textIndex.addDocument(terms);

      // Enforce tier limits (must run after in-memory cache is updated)
      await this.enforceTierLimits(entry.tier);

      getLoggerSafe().debug("[AgentDBMemory] Stored entry", {
        id: id as string,
        type: entry.type,
        tier: entry.tier,
      });

      return ok(unifiedEntry as unknown as import("../memory.interface.js").MemoryEntry);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async storeEntries(
    entries: Array<
      Omit<UnifiedMemoryEntry, "id" | "createdAt" | "accessCount" | "lastAccessedAt" | "version">
    >,
  ): Promise<Result<MemoryId[], Error>> {
    try {
      const ids: MemoryId[] = [];
      for (const entry of entries) {
        const result = await this.storeEntry(entry);
        if (result.kind === "err") {
          return result;
        }
        ids.push(result.value.id);
      }
      return ok(ids);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---------------------------------------------------------------------------
  // Retrieval (delegates to agentdb-retrieval helpers)
  // ---------------------------------------------------------------------------

  async retrieve(
    query: string,
    options: RetrievalOptions,
  ): Promise<RetrievalResult<import("../memory.interface.js").MemoryEntry>[]> {
    if (options.mode === "semantic") {
      return retrieveSemanticHelper(this.getRetrievalCtx(), query, options);
    }
    return retrieveTFIDF(this.getRetrievalCtx(), query, options);
  }

  async retrieveSemantic(
    query: string,
    options: UnifiedMemoryQuery = {},
  ): Promise<RetrievalResult<import("../memory.interface.js").MemoryEntry>[]> {
    return retrieveSemanticHelper(this.getRetrievalCtx(), query, options);
  }

  async retrieveByEmbedding(
    embedding: Vector<number>,
    options: UnifiedMemoryQuery = {},
  ): Promise<RetrievalResult<import("../memory.interface.js").MemoryEntry>[]> {
    return this.retrieveSemantic("", { ...options, embedding });
  }

  async retrieveHybrid(
    query: string,
    options?: {
      semanticWeight?: NormalizedScore;
      tier?: MemoryTier;
      limit?: number;
      useMMR?: boolean;
      scope?: import("../memory.interface.js").MemoryScope;
    },
  ): Promise<RetrievalResult<import("../memory.interface.js").MemoryEntry>[]> {
    return retrieveHybridHelper(this.getRetrievalCtx(), query, options);
  }

  async getChatHistory(
    chatId: ChatId,
    limit: number = 10,
  ): Promise<import("../memory.interface.js").MemoryEntry[]> {
    const entries = Array.from(this.entries.values())
      .filter((e) => e.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);

    return entries as unknown as import("../memory.interface.js").MemoryEntry[];
  }

  async getByTier(
    tier: MemoryTier,
    limit?: number,
  ): Promise<import("../memory.interface.js").MemoryEntry[]> {
    const entries = Array.from(this.entries.values())
      .filter((e) => e.tier === tier)
      .sort((a, b) => b.importanceScore - a.importanceScore)
      .slice(0, limit);

    return entries as unknown as import("../memory.interface.js").MemoryEntry[];
  }

  async getById(
    id: MemoryId,
  ): Promise<Result<Option<import("../memory.interface.js").MemoryEntry>, Error>> {
    try {
      const entry = this.entries.get(id as string);
      if (!entry) {
        this.cacheMisses++;
        return ok(none());
      }

      this.cacheHits++;

      // Update access stats
      entry.accessCount++;
      entry.lastAccessedAt = getNow();

      return ok(some(entry as unknown as import("../memory.interface.js").MemoryEntry));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---------------------------------------------------------------------------
  // Memory Management
  // ---------------------------------------------------------------------------

  async promoteEntry(
    id: MemoryId,
    newTier: MemoryTier,
  ): Promise<Result<import("../memory.interface.js").MemoryEntry, Error>> {
    try {
      const entry = this.entries.get(id as string);
      if (!entry) {
        return err(new Error(`Entry not found: ${id}`));
      }

      // A Persistent entry promoted into Ephemeral used to get the Ephemeral
      // TTL, and cleanupExpired then deleted it for good if no later sweep
      // moved it on in time (MEM-11). Remember where it came from instead.
      if (entry.tier === MemoryTier.Persistent) entry.persistentOrigin = true;
      entry.tier = newTier;
      entry.importanceScore = Math.max(entry.importanceScore, 0.7) as NormalizedScore;

      // Update expiration
      entry.expiresAt = this.ephemeralExpiry(entry, newTier);

      sqlitePersistEntry(this.getSqliteCtx(), entry);

      getLoggerSafe().debug("[AgentDBMemory] Promoted entry", { id: id as string, newTier });
      return ok(entry as import("../memory.interface.js").MemoryEntry);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** The TTL an entry gets on entering `tier`: only Ephemeral entries not of persistent origin expire. */
  private ephemeralExpiry(entry: UnifiedMemoryEntry, tier: MemoryTier): TimestampMs | undefined {
    if (tier !== MemoryTier.Ephemeral || entry.persistentOrigin === true) return undefined;
    return createBrand(Date.now() + this.config.ephemeralTtlMs, "TimestampMs" as const);
  }

  async demoteEntry(
    id: MemoryId,
    newTier: MemoryTier,
  ): Promise<Result<import("../memory.interface.js").MemoryEntry, Error>> {
    try {
      const entry = this.entries.get(id as string);
      if (!entry) {
        return err(new Error(`Entry not found: ${id}`));
      }

      entry.tier = newTier;

      // Update expiration: Ephemeral gets a fresh TTL, every other tier has
      // none. This used to leave the old (often already past) TTL on an
      // Ephemeral->Persistent demotion; cleanupExpired only reaps Ephemeral
      // entries but retrieveSemantic skips any past expiresAt, so the entry
      // became a permanent ghost — stored, indexed, counted, never returned.
      // Mirrors promoteEntry (audited 2026-09-02).
      entry.expiresAt = this.ephemeralExpiry(entry, newTier);

      sqlitePersistEntry(this.getSqliteCtx(), entry);

      getLoggerSafe().debug("[AgentDBMemory] Demoted entry", { id: id as string, newTier });
      return ok(entry as import("../memory.interface.js").MemoryEntry);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async updateImportance(
    id: MemoryId,
    importance: NormalizedScore,
  ): Promise<Result<import("../memory.interface.js").MemoryEntry, Error>> {
    try {
      const entry = this.entries.get(id as string);
      if (!entry) {
        return err(new Error(`Entry not found: ${id}`));
      }

      entry.importanceScore = importance;
      sqlitePersistEntry(this.getSqliteCtx(), entry);
      return ok(entry as import("../memory.interface.js").MemoryEntry);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Write an edited copy of a stored entry through to the cache and SQLite.
   * AgentDBAdapter's updateEntry / resolveError / archiveOldEntries call this,
   * and it did not exist, so each of them failed with a TypeError (MEM-17).
   * Content, embedding and identity stay as stored. The caller merged its own
   * values into metadata and the type-specific text fields (a resolution, a
   * message), so those are secret-redacted here as storeEntry would (MEM-21).
   */
  persistEntry(entry: UnifiedMemoryEntry): void {
    const id = entry.id as string;
    const live = this.entries.get(id);
    if (!live) throw new Error(`Entry not found: ${id}`);
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      redacted[key] = typeof value === "string" && !PERSIST_UNREDACTED_FIELDS.has(key) ? redactSecrets(value) : value;
    }
    const updated = {
      ...redacted,
      id: live.id,
      content: live.content,
      embedding: live.embedding,
      metadata: entry.metadata ? sanitizeSecretsDeep(entry.metadata) : entry.metadata,
    } as UnifiedMemoryEntry;
    sqlitePersistEntry(this.getSqliteCtx(), updated);
    Object.assign(live, updated);
  }

  async touch(id: MemoryId): Promise<Result<void, Error>> {
    try {
      const entry = this.entries.get(id as string);
      if (!entry) {
        return err(new Error(`Entry not found: ${id}`));
      }

      entry.accessCount++;
      entry.lastAccessedAt = getNow();
      sqlitePersistEntry(this.getSqliteCtx(), entry);
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async cleanupExpired(): Promise<number> {
    const now = getNow();
    let removed = 0;

    for (const [id, entry] of this.entries) {
      if (entry.tier === MemoryTier.Ephemeral && entry.expiresAt && entry.expiresAt < now) {
        // Mirror the removal in the TF-IDF index — extractTerms needs the content
        // before it leaves this.entries, else df/docCount drift forever (leak fix).
        this.textIndex.removeDocument(extractTerms(entry.content));
        this.entries.delete(id);
        if (this.hnswStore) {
          const store = this.hnswStore;
          await this.writeMutex.withLock(() => store.remove([id]));
        }
        sqliteRemovePersistedEntry(this.getSqliteCtx(), id);
        removed++;
      }
    }

    if (removed > 0) {
      getLoggerSafe().info("[AgentDBMemory] Cleaned up expired entries", { removed });
    }

    return removed;
  }

  async compact(): Promise<{ freedBytes: number }> {
    try {
      getLoggerSafe().info("[AgentDBMemory] Compacting storage");

      // Rebuild HNSW index
      await this.rebuildIndex();

      // Clean up expired entries
      await this.cleanupExpired();

      // Save to disk
      await this.saveEntries();

      return { freedBytes: 0 }; // TODO: Calculate actual freed bytes
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Compact failed", { error: String(error) });
      return { freedBytes: 0 };
    }
  }

  async delete(id: MemoryId): Promise<Result<boolean, Error>> {
    try {
      const existed = this.entries.has(id as string);
      if (existed) {
        // Mirror the removal in the TF-IDF index before the entry leaves this.entries.
        const entry = this.entries.get(id as string);
        if (entry) this.textIndex.removeDocument(extractTerms(entry.content));
        this.entries.delete(id as string);
        if (this.hnswStore) {
          const store = this.hnswStore;
          await this.writeMutex.withLock(() => store.remove([id as string]));
        }
        sqliteRemovePersistedEntry(this.getSqliteCtx(), id as string);
      }
      return ok(existed);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  getStats(): UnifiedMemoryStats {
    const entries = Array.from(this.entries.values());
    const byTier = {
      [MemoryTier.Working]: entries.filter((e) => e.tier === MemoryTier.Working).length,
      [MemoryTier.Ephemeral]: entries.filter((e) => e.tier === MemoryTier.Ephemeral).length,
      [MemoryTier.Persistent]: entries.filter((e) => e.tier === MemoryTier.Persistent).length,
    };

    const hnswStats = this.hnswStore?.getHNSWStats();
    const avgSearchTime =
      this.searchTimes.length > 0
        ? this.searchTimes.reduce((a, b) => a + b, 0) / this.searchTimes.length
        : 0;

    // Build tier stats
    const tierStats: Record<
      MemoryTier,
      { tier: MemoryTier; entryCount: number; maxEntries: number; averageImportance: number }
    > = {
      [MemoryTier.Working]: {
        tier: MemoryTier.Working,
        entryCount: byTier[MemoryTier.Working],
        maxEntries: this.config.maxEntriesPerTier[MemoryTier.Working],
        averageImportance: 0.5,
      },
      [MemoryTier.Ephemeral]: {
        tier: MemoryTier.Ephemeral,
        entryCount: byTier[MemoryTier.Ephemeral],
        maxEntries: this.config.maxEntriesPerTier[MemoryTier.Ephemeral],
        averageImportance: 0.5,
      },
      [MemoryTier.Persistent]: {
        tier: MemoryTier.Persistent,
        entryCount: byTier[MemoryTier.Persistent],
        maxEntries: this.config.maxEntriesPerTier[MemoryTier.Persistent],
        averageImportance: 0.5,
      },
    };

    // Calculate average importance per tier
    for (const tier of Object.values(MemoryTier)) {
      const tierEntries = entries.filter((e) => e.tier === tier);
      if (tierEntries.length > 0) {
        tierStats[tier].averageImportance =
          tierEntries.reduce((sum, e) => sum + e.importanceScore, 0) / tierEntries.length;
      }
    }

    const quantOriginalBytes = entries.length * this.config.dimensions * 4;
    const quantCompressedBytes = hnswStats?.memoryUsageBytes ?? quantOriginalBytes;

    return {
      totalEntries: entries.length,
      entriesByType: {
        conversation: entries.filter((e) => e.type === "conversation").length,
        analysis: entries.filter((e) => e.type === "analysis").length,
        note: entries.filter((e) => e.type === "note").length,
        insight: entries.filter((e) => e.type === "insight").length,
        error: entries.filter((e) => e.type === "error").length,
        command: entries.filter((e) => e.type === "command").length,
        task: entries.filter((e) => e.type === "task").length,
        project: entries.filter((e) => e.type === "project").length,
      },
      entriesByImportance: {
        low: entries.filter((e) => e.importance === "low").length,
        medium: entries.filter((e) => e.importance === "medium").length,
        high: entries.filter((e) => e.importance === "high").length,
        critical: entries.filter((e) => e.importance === "critical").length,
      },
      conversationCount: entries.filter((e) => e.type === "conversation").length,
      noteCount: entries.filter((e) => e.type === "note").length,
      errorCount: entries.filter((e) => e.type === "error").length,
      archivedCount: entries.filter((e) => e.archived).length,
      hasAnalysisCache: this.cachedAnalysis !== null,
      storageSizeBytes: entries.length * this.config.dimensions * 4,
      averageQueryTimeMs: avgSearchTime,
      entriesByTier: byTier,
      hnswStats: {
        indexedVectors: hnswStats?.elementCount ?? 0,
        dimensions: this.config.dimensions,
        efConstruction: this.config.hnswParams.efConstruction,
        M: this.config.hnswParams.M,
        efSearch: this.config.hnswParams.efSearch,
        maxElements: Object.values(this.config.maxEntriesPerTier).reduce((a, b) => a + b, 0),
        currentCount: hnswStats?.elementCount ?? 0,
        memoryUsedBytes: hnswStats?.memoryUsageBytes ?? 0,
      },
      quantizationStats: {
        type: this.config.quantizationType,
        originalSizeBytes: quantOriginalBytes,
        compressedSizeBytes: quantCompressedBytes,
        compressionRatio: quantCompressedBytes > 0 ? quantOriginalBytes / quantCompressedBytes : 1,
        bitsPerDimension: this.config.quantizationType === "scalar" ? 8 : 32,
      },
      performance: {
        avgSearchTimeMs: avgSearchTime,
        lastSearchTimeMs: this.searchTimes[this.searchTimes.length - 1] ?? 0,
        totalSearches: this.searchTimes.length,
        cacheHitRate: 0,
        indexBuildTimeMs: 0,
        memoryUsageBytes: entries.length * this.config.dimensions * 4,
      },
      cacheStats: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        evictions: 0,
        currentSize: this.entries.size,
        maxSize: Object.values(this.config.maxEntriesPerTier).reduce((a, b) => a + b, 0),
        hitRate: this.cacheHits / Math.max(1, this.cacheHits + this.cacheMisses),
      },
      tierStats: tierStats as unknown as Record<
        MemoryTier,
        import("./unified-memory.interface.js").TierStats
      >,
    };
  }

  getMigrationStatus(): MigrationStatus {
    return { ...this.migrationStatus };
  }

  // ---------------------------------------------------------------------------
  // HNSW Index Operations
  // ---------------------------------------------------------------------------

  /**
   * Rebuild the HNSW index from `this.entries`.
   *
   * @param pending Vectors that must be part of the rebuilt index but are not
   *   in `this.entries` yet — storeEntry passes the entry it is in the middle
   *   of writing when the insert trips index capacity. Without it the rebuild
   *   silently excluded exactly the entry it was recovering for
   *   (audited 2026-09-02). `replaceAll` sizes the index to fit them.
   */
  async rebuildIndex(pending: VectorEntry[] = []): Promise<Result<void, Error>> {
    try {
      if (!this.hnswStore) return ok(undefined);

      getLoggerSafe().info("[AgentDBMemory] Rebuilding HNSW index", { pending: pending.length });

      // Rebuild from all entries, skipping those with mismatched dimensions
      const entries = Array.from(this.entries.values());
      const expectedDimensions = this.config.dimensions;
      let dimensionMismatchCount = 0;
      const vectorEntries: VectorEntry[] = [...pending];
      let provenanceSkipped = 0;
      for (const e of entries) {
        if (e.embedding && e.embedding.length !== expectedDimensions) {
          dimensionMismatchCount++;
          continue;
        }
        if (e.embedding && !canEnterIndex(this.config, e)) {
          provenanceSkipped++;
          continue;
        }
        vectorEntries.push(toVectorEntry({
          id: e.id as string,
          content: e.content,
          chatId: e.chatId as string | undefined,
          embedding: e.embedding,
          createdAt: e.createdAt as number,
          accessCount: e.accessCount,
        }));
      }
      if (dimensionMismatchCount > 0) {
        getLoggerSafe().warn(
          `[AgentDB] Skipped ${dimensionMismatchCount} entries with mismatched embedding dimensions (expected ${expectedDimensions})`,
        );
      }
      if (provenanceSkipped > 0) {
        getLoggerSafe().warn(
          `[AgentDB] Kept ${provenanceSkipped} entries out of the HNSW index — embedding provenance differs from ${indexProvenance(this.config)}`,
        );
      }

      // Clear and re-add (mutex-serialized to prevent interleaved writes)
      const store = this.hnswStore;
      await this.writeMutex.withLock(() => store.replaceAll(vectorEntries));

      getLoggerSafe().info("[AgentDBMemory] Index rebuild complete", { count: vectorEntries.length });
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Expose internals for the memory consolidation engine (Phase 25).
   * Returns SQLite DB, entries map, HNSW store, and write mutex references.
   */
  getConsolidationInternals(): {
    sqliteDb: import("better-sqlite3").Database | null;
    entries: Map<string, UnifiedMemoryEntry>;
    hnswStore: HNSWVectorStore | undefined;
    hnswWriteMutex: HnswWriteMutex;
    /** TF-IDF index — the engine must mirror its entries-Map mutations here (audited 2026-09-02). */
    textIndex: TextIndex;
  } {
    return {
      sqliteDb: this.sqliteDb,
      entries: this.entries,
      hnswStore: this.hnswStore,
      hnswWriteMutex: this.writeMutex,
      textIndex: this.textIndex,
    };
  }

  getIndexHealth(): HnswHealth {
    const issues: string[] = [];
    const hnswStats = this.hnswStore?.getHNSWStats();

    if (!hnswStats) {
      issues.push("HNSW index not initialized");
      return {
        isHealthy: false,
        issues,
        fillRatio: 0,
        averageConnections: 0,
        fragmentationRatio: 0,
      };
    }

    if (this.sqliteInitFailed) {
      issues.push("SQLite initialization failed — persistence unavailable");
    }

    // The integrity verdict used to go nowhere (audited 2026-09-02).
    if (this.sqliteIntegrityFailed) {
      issues.push(
        "memory.db failed integrity_check and REINDEX did not repair it — rows may be unreadable or silently missing",
      );
    }

    if (hnswStats.elementCount === 0 && this.entries.size > 0) {
      issues.push("HNSW index empty but entries exist");
    }

    if (hnswStats.elementCount > hnswStats.maxElements * 0.9) {
      issues.push("HNSW index near capacity");
    }

    if (hnswStats.avgSearchTimeMs > 10) {
      issues.push("Search latency above threshold (>10ms)");
    }

    const fillRatio = (hnswStats.elementCount / hnswStats.maxElements) as NormalizedScore;

    return {
      isHealthy: issues.length === 0,
      issues,
      fillRatio,
      averageConnections: this.config.hnswParams.M,
      fragmentationRatio: 0,
    };
  }

  async optimizeIndex(): Promise<Result<void, Error>> {
    getLoggerSafe().warn(
      "[AgentDBMemory] optimizeIndex() not yet implemented — no optimization performed",
    );
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Private: Load / Save entries (composite operations using helpers)
  // ---------------------------------------------------------------------------

  private async loadEntries(): Promise<void> {
    if (!this.sqliteDb) return;

    try {
      const stmt = this.sqliteStatements.get("getAllMemories");
      if (!stmt) return;

      const rows = stmt.all() as MemoryRow[];

      let loaded = 0;
      let skipped = 0;

      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.value) as Record<string, unknown>;
          const embedding = row.embedding ? bufferToEmbedding(row.embedding as Buffer) : null;

          const baseEntry = {
            id: createBrand(row.id, "MemoryId" as const),
            type: parsed.type as string,
            content: parsed.content as string,
            createdAt: createBrand(row.created_at, "TimestampMs" as const),
            tags: (parsed.tags as string[]) ?? [],
            importance: (parsed.importance as string) ?? "medium",
            archived: (parsed.archived as boolean) ?? false,
            metadata: JSON.parse(row.metadata) as Record<string, unknown>,
            embedding,
            tier: (parsed.tier as MemoryTier) ?? MemoryTier.Ephemeral,
            accessCount: (parsed.accessCount as number) ?? 0,
            lastAccessedAt: createBrand(
              (parsed.lastAccessedAt as number) ?? row.created_at,
              "TimestampMs" as const,
            ),
            expiresAt: parsed.expiresAt
              ? createBrand(parsed.expiresAt as number, "TimestampMs" as const)
              : undefined,
            hnswIndex: (parsed.hnswIndex as number) ?? 0,
            version: (parsed.version as number) ?? 1,
            importanceScore:
              (parsed.importanceScore as NormalizedScore) ?? (0.5 as NormalizedScore),
            decayedAt: typeof parsed.decayedAt === "number" ? parsed.decayedAt : undefined,
            persistentOrigin: parsed.persistentOrigin === true ? true : undefined,
            domain: parsed.domain as string | undefined,
            chatId: createBrand((parsed.chatId as string) ?? "default", "ChatId" as const),
            // plan 0-B.9: rows written before provenance existed are classified by shape
            embeddingProvenance: (parsed.embeddingProvenance as string | undefined)
              ?? inferProvenance(this.config, embedding),
            userId: parsed.userId as string | undefined,
            projectId: parsed.projectId as string | undefined,
            shared: parsed.shared === true ? true : undefined,
          };

          // Reconstruct as UnifiedMemoryEntry based on type
          const unifiedEntry = baseEntry as unknown as UnifiedMemoryEntry;
          this.entries.set(row.id, unifiedEntry);

          // If embedding was missing, try to regenerate it
          if (!embedding) {
            try {
              const embedded = await embedWithProvenance(this.config, parsed.content as string);
              (unifiedEntry as unknown as { embedding: Vector<number>; embeddingProvenance: string })
                .embedding = embedded.embedding;
              (unifiedEntry as unknown as { embeddingProvenance: string })
                .embeddingProvenance = embedded.provenance;
              sqlitePersistEntry(this.getSqliteCtx(), unifiedEntry);
            } catch {
              // Continue without embedding — text search still works
              skipped++;
            }
          }

          // Re-index in text search
          const terms = extractTerms(parsed.content as string);
          this.textIndex.addDocument(terms);

          loaded++;
        } catch (entryError) {
          getLoggerSafe().error("[AgentDBMemory] Failed to load entry", {
            id: row.id,
            error: String(entryError),
          });
          skipped++;
        }
      }

      // Rebuild HNSW index from loaded entries
      if (this.hnswStore) {
        const vectors: VectorEntry[] = [];
        let dimensionMismatchCount = 0;
        let provenanceSkipped = 0;
        const expectedDimensions = this.config.dimensions;
        for (const entry of this.entries.values()) {
          if (entry.embedding) {
            if (entry.embedding.length !== expectedDimensions) {
              dimensionMismatchCount++;
              continue;
            }
            if (!canEnterIndex(this.config, entry)) {
              provenanceSkipped++;
              continue;
            }
            vectors.push(toVectorEntry({
              id: entry.id as string,
              content: entry.content,
              chatId: entry.chatId as string | undefined,
              embedding: entry.embedding,
              createdAt: entry.createdAt as number,
              accessCount: entry.accessCount,
            }));
          }
        }
        if (dimensionMismatchCount > 0) {
          getLoggerSafe().warn(
            `[AgentDB] Skipped ${dimensionMismatchCount} entries with mismatched embedding dimensions (expected ${expectedDimensions}). ` +
            "These entries remain in SQLite and will be re-embedded when an embedding provider is available.",
          );
        }
        if (provenanceSkipped > 0) {
          // Codex round 6 #17/#18: logged once per boot; the provider index
          // never searches across them. reEmbedHashEntries (bootstrap) re-embeds
          // histogram, unknown and foreign-provider vectors with the current provider.
          getLoggerSafe().warn(
            `[AgentDB] Kept ${provenanceSkipped} entries out of the HNSW index — embedding provenance differs from ${indexProvenance(this.config)}; re-embedding needed (text path still serves them)`,
          );
        }
        const store = this.hnswStore;
        await this.writeMutex.withLock(() => store.replaceAll(vectors));
        getLoggerSafe().info("[AgentDBMemory] Rebuilt HNSW index from SQLite", {
          count: vectors.length,
        });
      }

      getLoggerSafe().info("[AgentDBMemory] Loaded entries from SQLite", { loaded, skipped });
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to load entries from SQLite", {
        error: String(error),
      });
    }
  }

  private async saveEntries(): Promise<void> {
    saveAllEntries(this.getSqliteCtx());
  }

  // ---------------------------------------------------------------------------
  // Migration Markers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a migration marker exists by key.
   */
  async hasMigrationMarker(key: string): Promise<boolean> {
    if (!this.sqliteDb) return false;
    try {
      const stmt = this.sqliteStatements.get("getMigrationMarker");
      if (!stmt) return false;
      const row = stmt.get(key);
      return row !== undefined;
    } catch (error) {
      getLoggerSafe().warn("[AgentDB] Failed to check migration marker", {
        key,
        error: String(error),
      });
      return false;
    }
  }

  /**
   * Set a migration marker, recording completion time and optional metadata.
   */
  async setMigrationMarker(key: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.sqliteDb) return;
    try {
      const stmt = this.sqliteStatements.get("setMigrationMarker");
      if (!stmt) return;
      stmt.run(key, Date.now(), metadata ? JSON.stringify(metadata) : null);
    } catch (error) {
      getLoggerSafe().warn("[AgentDB] Failed to set migration marker", {
        key,
        error: String(error),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Hash-to-Real Embedding Migration (delegates to agentdb-vector)
  // ---------------------------------------------------------------------------

  async reEmbedHashEntries(options: ReEmbedOptions = {}): Promise<ReEmbedResult> {
    const pass = reEmbedHashEntries(
      this.getVectorCtx(),
      this.hasMigrationMarker.bind(this),
      this.setMigrationMarker.bind(this),
      {
        ...options,
        // Shutdown ends a pass at its next batch instead of letting it write
        // to a closing store, and a rebuild for a new embedding size
        // re-embeds every row itself.
        shouldStop: () => this.shuttingDown || this.rebuildInProgress || options.shouldStop?.() === true,
      },
    );
    this.reEmbedPasses.add(pass);
    try {
      return await pass;
    } finally {
      this.reEmbedPasses.delete(pass);
    }
  }

  /**
   * Rows the configured embedding provider still has to re-embed before its
   * index can hold them (hash-fallback, unknown-origin or other-provider
   * vectors); text search serves them meanwhile. 0 without a provider, or
   * once the memory is shut down.
   */
  countEntriesAwaitingReEmbed(): number {
    if (!this.config.embeddingProvider || !this.isInitialized || this.shuttingDown) return 0;
    return countEntriesNeedingReEmbedding({ config: this.config, entries: this.entries });
  }

  // ---------------------------------------------------------------------------
  // Pattern Storage (SQLite-backed)
  // ---------------------------------------------------------------------------

  /**
   * Store a pattern with a key and confidence score.
   */
  storePattern(patternKey: string, data: Record<string, unknown>, confidence: number): void {
    if (!this.sqliteDb) return;

    try {
      const stmt = this.sqliteStatements.get("upsertPattern");
      if (!stmt) return;

      const id = createHash("sha256").update(patternKey).digest("hex").slice(0, 32);
      // Security: sanitize pattern data (may contain captured prompts / outputs) before writing.
      // Redacted per value, never over the serialized JSON and never cut, so
      // the row still parses on read (SEC-3). patternKey is an identifier.
      const sanitizedData = stringifyRedacted(data);
      stmt.run(id, patternKey, sanitizedData, confidence, Date.now());
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to store pattern", {
        patternKey,
        error: String(error),
      });
    }
  }

  /**
   * Retrieve patterns by key, ordered by confidence descending.
   */
  getPatterns(
    patternKey: string,
  ): Array<{ id: string; data: Record<string, unknown>; confidence: number; createdAt: number }> {
    if (!this.sqliteDb) return [];

    try {
      const stmt = this.sqliteStatements.get("getPatternsByKey");
      if (!stmt) return [];

      const rows = stmt.all(patternKey) as PatternRow[];
      // One damaged row (older builds truncated the stored JSON) must not
      // hide every other pattern for the key.
      return rows.flatMap((row) => {
        try {
          return [{
            id: row.id,
            data: JSON.parse(row.data) as Record<string, unknown>,
            confidence: row.confidence,
            createdAt: row.created_at,
          }];
        } catch {
          getLoggerSafe().warn("[AgentDBMemory] Skipped an unreadable pattern row", { id: row.id, patternKey });
          return [];
        }
      });
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to get patterns", {
        patternKey,
        error: String(error),
      });
      return [];
    }
  }
}

/**
 * Create AgentDB memory manager with configuration
 */
export async function createAgentDBMemory(
  config?: Partial<UnifiedMemoryConfig>,
): Promise<AgentDBMemory> {
  const memory = new AgentDBMemory(config);
  const initResult = await memory.initialize();
  if (initResult.kind === "err") {
    throw initResult.error;
  }
  return memory;
}
