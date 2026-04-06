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

import { join } from "node:path";
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
import type { RetrievalOptions, RetrievalResult } from "../memory.interface.js";
import type { StradaProjectAnalysis } from "../../intelligence/strada-analyzer.js";
import { getLogger } from "../../utils/logger.js";
import type { HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import type { VectorEntry } from "../../rag/rag.interface.js";
import { createHNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
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
  generateEmbedding,
  isHashBasedEmbedding,
  detectAndHandleDimensionMismatch,
  reEmbedHashEntries,
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
  private sqliteStatements: Map<string, Database.Statement> = new Map();
  private decayConfig: MemoryDecayConfig | null = null;
  private userProfileStore: UserProfileStore | null = null;
  private taskExecutionStore: TaskExecutionStore | null = null;
  private rebuildInProgress = false;

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
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<Result<void, Error>> {
    try {
      if (this.isInitialized) return ok(undefined);

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

      // Initialize HNSW vector store
      const vectorStorePath = join(this.dbPath, "hnsw");
      this.hnswStore = await createHNSWVectorStore(vectorStorePath, {
        dimensions: this.config.dimensions,
        maxElements: Object.values(this.config.maxEntriesPerTier).reduce((a, b) => a + b, 0),
        M: this.config.hnswParams.M,
        efConstruction: this.config.hnswParams.efConstruction,
        efSearch: this.config.hnswParams.efSearch,
        metric: "cosine",
        quantization: this.config.quantizationType,
      });

      // Detect HNSW dimension mismatch (e.g. user switched embedding provider)
      // Writes through to this.hnswStore via proxy if rebuild occurs
      await detectAndHandleDimensionMismatch(this.getVectorCtx());

      // Load existing entries from AgentDB-style storage
      await this.loadEntries();

      this.isInitialized = true;

      getLoggerSafe().info("[AgentDBMemory] Initialization complete", {
        entries: this.entries.size,
        hnswElements: this.hnswStore?.count() ?? 0,
      });

      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async shutdown(): Promise<Result<void, Error>> {
    try {
      if (!this.isInitialized) return ok(undefined);

      getLoggerSafe().info("[AgentDBMemory] Shutting down");

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
        .catch(e => getLoggerSafe().error("[AgentDBMemory] Auto-tiering sweep failed", { error: String(e) })),
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

      // Also store in persistent memory for long-term retention
      const storeResult = await this.storeEntry({
        type: "analysis",
        content: JSON.stringify(analysis),
        tags: ["project-analysis", "cached"],
        importance: "high",
        archived: false,
        metadata: { projectPath },
        embedding: await generateEmbedding(this.config, JSON.stringify(analysis)),
        tier: MemoryTier.Persistent,
        importanceScore: createBrand(0.9, "NormalizedScore" as const),
        domain: "analysis-cache",
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
    if (!this.cachedAnalysis) return null;
    if (this.cachedAnalysis.projectPath !== projectPath) return null;

    const age = Date.now() - this.cachedAnalysis.analysis.analyzedAt.getTime();
    if (age > maxAgeMs) return null;

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
      embedding: await generateEmbedding(this.config, summary),
      tier,
      importanceScore: calculateImportanceScore(summary, tier),
      chatId,
    });

    if (result.kind === "err") {
      throw result.error;
    }

    return result.value;
  }

  async storeNote(
    content: string,
    tags: string[] = [],
    tier: MemoryTier = MemoryTier.Persistent,
  ): Promise<import("../memory.interface.js").MemoryEntry> {
    const result = await this.storeEntry({
      type: "note",
      content,
      tags: [...tags, "note"],
      importance: "medium",
      archived: false,
      metadata: {},
      embedding: await generateEmbedding(this.config, content),
      tier,
      importanceScore: calculateImportanceScore(content, tier),
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

      const id = createBrand(randomUUID(), "MemoryId" as const);
      const now = getNow();

      // Generate embedding if not provided
      const embedding = entry.embedding ?? (await generateEmbedding(this.config, entry.content));

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
        tier: entry.tier,
        accessCount: 0,
        lastAccessedAt: now,
        expiresAt,
        hnswIndex: this.hnswStore?.count() ?? 0,
        version: 1,
        importanceScore: entry.importanceScore,
        domain: entry.domain,
        chatId: entry.chatId ?? createBrand("default", "ChatId" as const),
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
      } else {
        unifiedEntry = baseEntry as unknown as UnifiedMemoryEntry;
      }

      // Store in memory
      this.entries.set(id as string, unifiedEntry);

      // Add to HNSW index (mutex-serialized to prevent interleaved writes)
      if (this.hnswStore && embedding.length === this.config.dimensions) {
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
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("exceeds the specified limit") || message.includes("Index capacity exceeded")) {
            getLoggerSafe().warn(
              "[AgentDBMemory] HNSW index capacity mismatch detected, rebuilding index",
              { error: message, entryId: id as string },
            );
            const rebuildResult = await this.rebuildIndex();
            if (rebuildResult.kind === "err") {
              return err(rebuildResult.error);
            }
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

      // Add to text index for backward compatibility
      const terms = extractTerms(entry.content);
      this.textIndex.addDocument(terms);

      // Persist to SQLite
      sqlitePersistEntry(this.getSqliteCtx(), unifiedEntry);

      // Enforce tier limits
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
      if (!entry) return ok(none());

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

      entry.tier = newTier;
      entry.importanceScore = Math.max(entry.importanceScore, 0.7) as NormalizedScore;

      // Update expiration
      if (newTier === MemoryTier.Ephemeral) {
        entry.expiresAt = createBrand(
          Date.now() + this.config.ephemeralTtlMs,
          "TimestampMs" as const,
        );
      } else {
        entry.expiresAt = undefined;
      }

      sqlitePersistEntry(this.getSqliteCtx(), entry);

      getLoggerSafe().debug("[AgentDBMemory] Promoted entry", { id: id as string, newTier });
      return ok(entry as import("../memory.interface.js").MemoryEntry);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
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

      // Update expiration for ephemeral
      if (newTier === MemoryTier.Ephemeral) {
        entry.expiresAt = createBrand(
          Date.now() + this.config.ephemeralTtlMs,
          "TimestampMs" as const,
        );
      }

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
        originalSizeBytes: entries.length * this.config.dimensions * 4,
        compressedSizeBytes:
          hnswStats?.memoryUsageBytes ?? entries.length * this.config.dimensions * 4,
        compressionRatio: 4,
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
        hits: 0,
        misses: 0,
        evictions: 0,
        currentSize: this.entries.size,
        maxSize: Object.values(this.config.maxEntriesPerTier).reduce((a, b) => a + b, 0),
        hitRate: 0,
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

  async rebuildIndex(): Promise<Result<void, Error>> {
    try {
      if (!this.hnswStore) return ok(undefined);

      getLoggerSafe().info("[AgentDBMemory] Rebuilding HNSW index");

      // Rebuild from all entries, skipping those with mismatched dimensions
      const entries = Array.from(this.entries.values());
      const expectedDimensions = this.config.dimensions;
      let dimensionMismatchCount = 0;
      const vectorEntries: VectorEntry[] = [];
      for (const e of entries) {
        if (e.embedding && e.embedding.length !== expectedDimensions) {
          dimensionMismatchCount++;
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

      // Clear and re-add (mutex-serialized to prevent interleaved writes)
      const store = this.hnswStore;
      await this.writeMutex.withLock(() => store.replaceAll(vectorEntries));

      getLoggerSafe().info("[AgentDBMemory] Index rebuild complete", { count: entries.length });
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
  } {
    return {
      sqliteDb: this.sqliteDb,
      entries: this.entries,
      hnswStore: this.hnswStore,
      hnswWriteMutex: this.writeMutex,
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
            domain: parsed.domain as string | undefined,
            chatId: createBrand((parsed.chatId as string) ?? "default", "ChatId" as const),
          };

          // Reconstruct as UnifiedMemoryEntry based on type
          const unifiedEntry = baseEntry as unknown as UnifiedMemoryEntry;
          this.entries.set(row.id, unifiedEntry);

          // If embedding was missing, try to regenerate it
          if (!embedding) {
            try {
              const newEmbedding = await generateEmbedding(this.config, parsed.content as string);
              (unifiedEntry as unknown as { embedding: Vector<number> }).embedding = newEmbedding;
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
        const expectedDimensions = this.config.dimensions;
        for (const entry of this.entries.values()) {
          if (entry.embedding) {
            if (entry.embedding.length !== expectedDimensions) {
              dimensionMismatchCount++;
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

  async reEmbedHashEntries(): Promise<{ migrated: number; total: number; skipped: number }> {
    return reEmbedHashEntries(
      this.getVectorCtx(),
      this.hasMigrationMarker.bind(this),
      this.setMigrationMarker.bind(this),
    );
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
      stmt.run(id, patternKey, JSON.stringify(data), confidence, Date.now());
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
      return rows.map((row) => ({
        id: row.id,
        data: JSON.parse(row.data) as Record<string, unknown>,
        confidence: row.confidence,
        createdAt: row.created_at,
      }));
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
