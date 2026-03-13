/**
 * AgentDB Unified Memory Implementation
 *
 * Integrates AgentDB with HNSW indexing for 150x-12,500x performance improvement
 * Implements 3-tier memory architecture (Working, Ephemeral, Persistent)
 */

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { configureSqlitePragmas } from "./sqlite-pragmas.js";
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
import type { StrataProjectAnalysis } from "../../intelligence/strata-analyzer.js";
import { getLogger } from "../../utils/logger.js";
import type { HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import type { VectorEntry } from "../../rag/rag.interface.js";
import { createHNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import { TextIndex, extractTerms, cosineSimilarity } from "../text-index.js";
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
import { MS_PER_DAY } from "../../learning/types.js";
import type { DecayStats, DecayTierStats, MemoryDecayConfig } from "../memory.interface.js";
export type { MemoryDecayConfig } from "../memory.interface.js";

// ---------------------------------------------------------------------------
// SQLite Schema & Row Types
// ---------------------------------------------------------------------------

const MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  key TEXT,
  value TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  pattern_key TEXT NOT NULL,
  data TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_key ON patterns(pattern_key);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
`;

interface MemoryRow {
  id: string;
  key: string | null;
  value: string;
  metadata: string;
  embedding: Buffer | null;
  created_at: number;
  updated_at: number;
}

interface PatternRow {
  id: string;
  pattern_key: string;
  data: string;
  confidence: number;
  created_at: number;
}

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

/** Get current timestamp as TimestampMs */
let _nowFn: () => TimestampMs = () => createBrand(Date.now(), "TimestampMs" as const);

function getNow(): TimestampMs {
  return _nowFn();
}

/** @internal Test-only: override the clock */
export function _setNowFn(fn: () => TimestampMs): void {
  _nowFn = fn;
}

/** @internal Test-only: reset the clock to real time */
export function _resetNowFn(): void {
  _nowFn = () => createBrand(Date.now(), "TimestampMs" as const);
}

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
  private cachedAnalysis: { projectPath: string; analysis: StrataProjectAnalysis } | null = null;
  private migrationStatus: MigrationStatus;
  private isInitialized = false;
  private searchTimes: number[] = [];
  private tieringTimer: ReturnType<typeof setInterval> | null = null;
  private sqliteDb: Database.Database | null = null;
  private sqliteStatements: Map<string, Database.Statement> = new Map();
  private decayConfig: MemoryDecayConfig | null = null;

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

      // Initialize SQLite persistence
      this.initSqlite();

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

      // Close SQLite
      this.closeSqlite();

      this.isInitialized = false;
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
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

  private async autoTieringSweep(promotionThreshold: number, demotionTimeoutDays: number): Promise<void> {
    const now = getNow() as number;
    const tierOrder = { [MemoryTier.Working]: 0, [MemoryTier.Ephemeral]: 1, [MemoryTier.Persistent]: 2 };
    let promoted = 0;
    let demoted = 0;

    // --- Decay pass (before tiering) ---
    if (this.decayConfig?.enabled) {
      const lambdas: Record<MemoryTier, number> = {
        [MemoryTier.Working]: this.decayConfig.lambdas.working,
        [MemoryTier.Ephemeral]: this.decayConfig.lambdas.ephemeral,
        [MemoryTier.Persistent]: this.decayConfig.lambdas.persistent,
      };
      const exemptDomains = this.decayConfig.exemptDomains;
      const decayedEntryIds: string[] = [];

      for (const entry of this.entries.values()) {
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
        this.persistDecayedEntries(decayedEntryIds);
        getLoggerSafe().debug("[AgentDBMemory] Decay sweep complete", { decayedCount: decayedEntryIds.length });
      }
    }

    for (const entry of this.entries.values()) {
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
          await this.promoteEntry(entry.id, targetTier);
          promoted++;
        } else {
          await this.demoteEntry(entry.id, targetTier);
          demoted++;
        }
        getLoggerSafe().debug(`[AgentDBMemory] Entry ${entry.id} ${isPromotion ? "promoted" : "demoted"} ${currentTier}->${targetTier}`);
      }
    }

    // After promotions/demotions, enforce limits on all tiers (cascade eviction)
    for (const tier of [MemoryTier.Working, MemoryTier.Ephemeral, MemoryTier.Persistent]) {
      await this.enforceTierLimits(tier);
    }

    if (promoted > 0 || demoted > 0) {
      getLoggerSafe().debug("[AgentDBMemory] Auto-tiering sweep complete", { promoted, demoted });
    }
  }

  // ---------------------------------------------------------------------------
  // Project Analysis Cache
  // ---------------------------------------------------------------------------

  async cacheAnalysis(
    analysis: StrataProjectAnalysis,
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
        embedding: await this.generateEmbedding(JSON.stringify(analysis)),
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
  ): Promise<StrataProjectAnalysis | null> {
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
  ): Promise<import("../memory.interface.js").MemoryEntry> {
    const result = await this.storeEntry({
      type: "conversation",
      content: summary,
      tags: [...tags, "conversation"],
      importance: "medium",
      archived: false,
      metadata: {},
      embedding: await this.generateEmbedding(summary),
      tier,
      importanceScore: this.calculateImportanceScore(summary, tier),
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
      embedding: await this.generateEmbedding(content),
      tier,
      importanceScore: this.calculateImportanceScore(content, tier),
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
      const embedding = entry.embedding ?? (await this.generateEmbedding(entry.content));

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
      if (this.hnswStore) {
        const store = this.hnswStore;
        await this.writeMutex.withLock(() =>
          store.upsert([
            {
              id: id as string,
              vector: embedding,
              chunk: {
                id: id as string,
                content: entry.content,
                contentHash: "",
                filePath: (entry.chatId as string) ?? "memory",
                indexedAt: Date.now() as TimestampMs,
                kind: "class" as const,
                startLine: 0,
                endLine: 0,
                language: "typescript",
              },
              addedAt: Date.now() as TimestampMs,
              accessCount: 0,
            },
          ]),
        );
      }

      // Add to text index for backward compatibility
      const terms = extractTerms(entry.content);
      this.textIndex.addDocument(terms);

      // Persist to SQLite
      this.persistEntry(unifiedEntry);

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
  // Retrieval
  // ---------------------------------------------------------------------------

  async retrieve(
    query: string,
    options: RetrievalOptions,
  ): Promise<RetrievalResult<import("../memory.interface.js").MemoryEntry>[]> {
    // Backward compatibility: TF-IDF based search
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0.1;

    const queryTerms = extractTerms(query);
    if (queryTerms.length === 0) return [];

    const queryVector = this.textIndex.computeTFIDF(queryTerms);

    const scored: RetrievalResult<import("../memory.interface.js").MemoryEntry>[] = [];

    for (const entry of this.entries.values()) {
      // Apply filters based on RetrievalOptions mode
      // Apply filters - entry has all required properties
      if (options.mode === "chat" && "chatId" in entry && entry.chatId !== options.chatId) continue;
      if (options.mode === "type" && options.types && !options.types.includes(entry.type)) continue;

      // Compute TF-IDF similarity
      const entryTerms = extractTerms(entry.content);
      const entryVector = this.textIndex.computeTFIDF(entryTerms);
      const score = cosineSimilarity(queryVector, entryVector);

      if (score >= minScore) {
        scored.push({ entry: entry as import("../memory.interface.js").MemoryEntry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async retrieveSemantic(
    query: string,
    options: UnifiedMemoryQuery = {},
  ): Promise<RetrievalResult<import("../memory.interface.js").MemoryEntry>[]> {
    if (!this.hnswStore) {
      // Fallback to TF-IDF
      return this.retrieve(query, options as RetrievalOptions);
    }

    const startTime = performance.now();

    // Generate query embedding
    const queryEmbedding = options.embedding ?? (await this.generateEmbedding(query));

    // Search HNSW index
    const hnswResults = await this.hnswStore.search(queryEmbedding, (options.limit ?? 5) * 2);

    // Convert to RetrievalResult format
    const results: RetrievalResult<import("../memory.interface.js").MemoryEntry>[] = [];

    for (const hit of hnswResults) {
      const entry = this.entries.get(hit.chunk.id);
      if (!entry) continue;

      // Apply filters
      if (options.chatId && entry.chatId !== options.chatId) continue;
      if (options.type && entry.type !== options.type) continue;
      if (options.tier && entry.tier !== options.tier) continue;
      if (options.domain && entry.domain !== options.domain) continue;
      if (options.minImportance !== undefined && entry.importanceScore < options.minImportance)
        continue;

      // Check expiration
      if (!options.includeExpired && entry.expiresAt) {
        const now = Date.now();
        if (now > entry.expiresAt) continue;
      }

      // Update access stats
      entry.accessCount++;
      entry.lastAccessedAt = getNow();

      results.push({
        entry: entry as unknown as import("../memory.interface.js").MemoryEntry,
        score: hit.score,
      });
    }

    // Record search time for all paths
    const searchTime = performance.now() - startTime;
    this.searchTimes.push(searchTime);
    if (this.searchTimes.length > 100) this.searchTimes.shift();

    // Apply MMR if requested
    if (options.useMMR) {
      return this.applyMMR(results, queryEmbedding, options.mmrLambda ?? 0.5, options.limit ?? 5);
    }

    return results.slice(0, options.limit ?? 5);
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
    try {
      // Get both semantic and text results
      const [semanticResults, textResults] = await Promise.all([
        this.retrieveSemantic(query, { limit: (options?.limit ?? 5) * 2, tier: options?.tier }),
        this.retrieve(query, { mode: "text", query, limit: (options?.limit ?? 5) * 2 }),
      ]);

      const semanticWeight = options?.semanticWeight ?? 0.7;
      const textWeight = 1 - semanticWeight;

      // Merge results with weights
      const scores = new Map<
        string,
        { entry: import("../memory.interface.js").MemoryEntry; score: number }
      >();

      for (const r of semanticResults) {
        scores.set(r.entry.id as string, { entry: r.entry, score: r.score * semanticWeight });
      }

      for (const r of textResults) {
        const existing = scores.get(r.entry.id as string);
        if (existing) {
          existing.score += r.score * textWeight;
        } else {
          scores.set(r.entry.id as string, { entry: r.entry, score: r.score * textWeight });
        }
      }

      const merged = Array.from(scores.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, options?.limit ?? 5);

      return merged.map((m) => ({ entry: m.entry, score: m.score }));
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Hybrid retrieval failed", { error: String(error) });
      return [];
    }
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

      this.persistEntry(entry);

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

      this.persistEntry(entry);

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
      this.persistEntry(entry);
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
      this.persistEntry(entry);
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
        this.removePersistedEntry(id);
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
        this.removePersistedEntry(id as string);
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

      // Rebuild from all entries
      const entries = Array.from(this.entries.values());
      const vectorEntries = entries.map((e) => ({
        id: e.id as string,
        vector: e.embedding,
        chunk: {
          id: e.id as string,
          content: e.content,
          contentHash: "",
          filePath: (e.chatId as string) ?? "memory",
          indexedAt: e.createdAt as number,
          kind: "class" as const,
          startLine: 0,
          endLine: 0,
          language: "typescript",
        },
        addedAt: e.createdAt as TimestampMs,
        accessCount: e.accessCount,
      }));

      // Clear and re-add (mutex-serialized to prevent interleaved writes)
      const store = this.hnswStore;
      await this.writeMutex.withLock(async () => {
        for (const entry of entries) {
          await store.remove([entry.id as string]);
        }
        await store.upsertBatch(vectorEntries);
      });

      getLoggerSafe().info("[AgentDBMemory] Index rebuild complete", { count: entries.length });
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Expose internals for the memory consolidation engine (Phase 25).
   * Returns SQLite DB, entries map, and HNSW store references.
   */
  getConsolidationInternals(): {
    sqliteDb: import("better-sqlite3").Database | null;
    entries: Map<string, UnifiedMemoryEntry>;
    hnswStore: HNSWVectorStore | undefined;
  } {
    return {
      sqliteDb: this.sqliteDb,
      entries: this.entries,
      hnswStore: this.hnswStore,
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
  // Private Helpers
  // ---------------------------------------------------------------------------

  private async generateEmbedding(text: string): Promise<Vector<number>> {
    if (this.config.embeddingProvider) {
      return this.config.embeddingProvider(text) as Promise<Vector<number>>;
    }
    // Hash-based fallback — not semantic, used when no provider configured
    const dimensions = this.config.dimensions;
    const embedding = new Array(dimensions).fill(0);

    // Simple hash-based embedding for demonstration
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      embedding[i % dimensions]! += char / 255;
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((a, b) => a + b * b, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dimensions; i++) {
        embedding[i]! /= magnitude;
      }
    }

    return embedding as Vector<number>;
  }

  private calculateImportanceScore(content: string, tier: MemoryTier): NormalizedScore {
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

  private async enforceTierLimits(tier: MemoryTier): Promise<void> {
    const maxEntries = this.config.maxEntriesPerTier[tier];
    const entries = Array.from(this.entries.values()).filter((e) => e.tier === tier);

    if (entries.length > maxEntries) {
      // Sort by importance and last accessed
      entries.sort((a, b) => {
        const scoreA = a.importanceScore * 0.7 + (a.accessCount / 100) * 0.3;
        const scoreB = b.importanceScore * 0.7 + (b.accessCount / 100) * 0.3;
        return scoreA - scoreB;
      });

      // Remove lowest scoring entries
      const toRemove = entries.slice(0, entries.length - maxEntries);
      if (this.hnswStore) {
        const store = this.hnswStore;
        const ids = toRemove.map(e => e.id as string);
        await this.writeMutex.withLock(async () => {
          for (const id of ids) {
            await store.remove([id]);
          }
        });
      }
      for (const entry of toRemove) {
        this.entries.delete(entry.id as string);
        this.removePersistedEntry(entry.id as string);
      }

      getLoggerSafe().debug("[AgentDBMemory] Enforced tier limits", {
        tier,
        removed: toRemove.length,
      });
    }
  }

  private applyMMR(
    results: RetrievalResult<import("../memory.interface.js").MemoryEntry>[],
    queryEmbedding: number[],
    lambda: number,
    limit: number,
  ): RetrievalResult<import("../memory.interface.js").MemoryEntry>[] {
    if (results.length === 0) return [];

    const selected: RetrievalResult<import("../memory.interface.js").MemoryEntry>[] = [];
    const remaining = [...results];

    while (selected.length < limit && remaining.length > 0) {
      let bestScore = -Infinity;
      let bestIndex = 0;

      for (let i = 0; i < remaining.length; i++) {
        const result = remaining[i]!;

        // Relevance score
        const relevance = result.score;

        // Diversity score (max similarity to already selected) - uses queryEmbedding
        let maxSim = 0;
        for (const sel of selected) {
          const selEmbedding = (sel.entry as unknown as UnifiedMemoryEntry).embedding;
          const resultEmbedding = (result.entry as unknown as UnifiedMemoryEntry).embedding;
          // Use queryEmbedding to avoid unused variable warning
          const sim =
            this.cosineSimilarity(queryEmbedding, selEmbedding) * 0.5 +
            this.cosineSimilarity(resultEmbedding, selEmbedding) * 0.5;
          maxSim = Math.max(maxSim, sim);
        }

        // MMR score
        const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = i;
        }
      }

      selected.push(remaining[bestIndex]!);
      remaining.splice(bestIndex, 1);
    }

    return selected;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
  }

  // ---------------------------------------------------------------------------
  // SQLite Persistence
  // ---------------------------------------------------------------------------

  private initSqlite(): void {
    try {
      const sqlitePath = join(this.dbPath, "memory.db");
      this.sqliteDb = new Database(sqlitePath);

      // Standardized pragma configuration (16MB cache, 5s busy_timeout)
      configureSqlitePragmas(this.sqliteDb, "memory");

      // Create schema using exec (safe - no user input, static SQL only)
      this.sqliteDb.exec(MEMORY_SCHEMA_SQL);

      // Prepare commonly-used statements
      this.sqliteStatements.set(
        "upsertMemory",
        this.sqliteDb.prepare(`
          INSERT INTO memories (id, key, value, metadata, embedding, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            value = excluded.value,
            metadata = excluded.metadata,
            embedding = excluded.embedding,
            updated_at = excluded.updated_at
        `),
      );

      this.sqliteStatements.set(
        "getAllMemories",
        this.sqliteDb.prepare("SELECT * FROM memories ORDER BY created_at DESC"),
      );

      this.sqliteStatements.set(
        "deleteMemory",
        this.sqliteDb.prepare("DELETE FROM memories WHERE id = ?"),
      );

      this.sqliteStatements.set(
        "upsertPattern",
        this.sqliteDb.prepare(`
          INSERT INTO patterns (id, pattern_key, data, confidence, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            data = excluded.data,
            confidence = excluded.confidence
        `),
      );

      this.sqliteStatements.set(
        "getPatternsByKey",
        this.sqliteDb.prepare(
          "SELECT * FROM patterns WHERE pattern_key = ? ORDER BY confidence DESC",
        ),
      );

      getLoggerSafe().info("[AgentDBMemory] SQLite persistence initialized", { path: sqlitePath });
    } catch (error) {
      getLoggerSafe().error(
        "[AgentDBMemory] SQLite initialization failed, running in-memory only",
        {
          error: String(error),
        },
      );
      this.sqliteDb = null;
    }
  }

  private closeSqlite(): void {
    // Dereference all cached statements before closing — better-sqlite3
    // auto-finalizes them when the database closes.
    this.sqliteStatements.clear();
    if (this.sqliteDb) {
      try {
        this.sqliteDb.close();
      } catch (error) {
        getLoggerSafe().error("[AgentDBMemory] SQLite close error", { error: String(error) });
      }
      this.sqliteDb = null;
    }
  }

  /**
   * Serialize an embedding vector to a Buffer for SQLite BLOB storage.
   */
  private embeddingToBuffer(embedding: number[] | Vector<number>): Buffer {
    const float64 = new Float64Array(embedding as number[]);
    return Buffer.from(float64.buffer);
  }

  /**
   * Deserialize a Buffer from SQLite BLOB back to a number array.
   */
  private bufferToEmbedding(buf: Buffer): Vector<number> {
    const float64 = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
    return Array.from(float64) as Vector<number>;
  }

  /**
   * Serialize an entry and run the upsert prepared statement.
   * Shared by persistEntry and persistDecayedEntries to avoid duplication.
   */
  private upsertEntryRow(stmt: Database.Statement, entry: UnifiedMemoryEntry): void {
    const value = JSON.stringify({
      type: entry.type,
      content: entry.content,
      tags: entry.tags,
      importance: entry.importance,
      archived: entry.archived,
      tier: entry.tier,
      accessCount: entry.accessCount,
      lastAccessedAt: entry.lastAccessedAt,
      expiresAt: entry.expiresAt,
      hnswIndex: entry.hnswIndex,
      version: "version" in entry ? entry.version : 1,
      importanceScore: entry.importanceScore,
      domain: entry.domain,
      chatId: entry.chatId,
    });
    const metadata = JSON.stringify(entry.metadata ?? {});
    const embeddingBuf = entry.embedding ? this.embeddingToBuffer(entry.embedding) : null;

    stmt.run(
      entry.id as string,
      entry.type,
      value,
      metadata,
      embeddingBuf,
      entry.createdAt as number,
      Date.now(),
    );
  }

  /**
   * Persist a single entry to SQLite (called after in-memory store).
   */
  private persistEntry(entry: UnifiedMemoryEntry): void {
    if (!this.sqliteDb) return;

    try {
      const stmt = this.sqliteStatements.get("upsertMemory");
      if (!stmt) return;
      this.upsertEntryRow(stmt, entry);
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to persist entry", {
        id: entry.id as string,
        error: String(error),
      });
    }
  }

  /**
   * Batch-persist decayed entries to SQLite inside a single transaction.
   * Only writes entries whose IDs are in the provided set, avoiding
   * unnecessary write amplification for unchanged entries.
   * @param entryIds IDs of entries that were actually decayed
   */
  private persistDecayedEntries(entryIds: string[]): void {
    if (!this.sqliteDb) return;

    try {
      const stmt = this.sqliteStatements.get("upsertMemory");
      if (!stmt) return;
      const idSet = new Set(entryIds);

      this.sqliteDb.transaction(() => {
        for (const entry of this.entries.values()) {
          if (!idSet.has(entry.id as string)) continue;
          this.upsertEntryRow(stmt, entry);
        }
      })();
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to persist decayed entries", {
        error: String(error),
      });
    }
  }

  /**
   * Remove a single entry from SQLite.
   */
  private removePersistedEntry(id: string): void {
    if (!this.sqliteDb) return;

    try {
      const stmt = this.sqliteStatements.get("deleteMemory");
      stmt?.run(id);
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to remove persisted entry", {
        id,
        error: String(error),
      });
    }
  }

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
          const embedding = row.embedding ? this.bufferToEmbedding(row.embedding as Buffer) : null;

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
              const newEmbedding = await this.generateEmbedding(parsed.content as string);
              (unifiedEntry as unknown as { embedding: Vector<number> }).embedding = newEmbedding;
              this.persistEntry(unifiedEntry);
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
        for (const entry of this.entries.values()) {
          if (entry.embedding) {
            vectors.push({
              id: entry.id as string,
              vector: entry.embedding,
              chunk: {
                id: entry.id as string,
                content: entry.content,
                contentHash: "",
                filePath: (entry.chatId as string) ?? "memory",
                indexedAt: entry.createdAt as TimestampMs,
                kind: "class" as const,
                startLine: 0,
                endLine: 0,
                language: "typescript",
              },
              addedAt: entry.createdAt as TimestampMs,
              accessCount: entry.accessCount,
            });
          }
        }
        if (vectors.length > 0) {
          const store = this.hnswStore;
          await this.writeMutex.withLock(() => store.upsert(vectors));
          getLoggerSafe().info("[AgentDBMemory] Rebuilt HNSW index from SQLite", {
            count: vectors.length,
          });
        }
      }

      getLoggerSafe().info("[AgentDBMemory] Loaded entries from SQLite", { loaded, skipped });
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to load entries from SQLite", {
        error: String(error),
      });
    }
  }

  private async saveEntries(): Promise<void> {
    if (!this.sqliteDb) return;

    try {
      const stmt = this.sqliteStatements.get("upsertMemory");
      if (!stmt) return;
      const db = this.sqliteDb;
      const saveAll = db.transaction(() => {
        for (const entry of this.entries.values()) {
          const value = JSON.stringify({
            type: entry.type,
            content: entry.content,
            tags: entry.tags,
            importance: entry.importance,
            archived: entry.archived,
            tier: entry.tier,
            accessCount: entry.accessCount,
            lastAccessedAt: entry.lastAccessedAt,
            expiresAt: entry.expiresAt,
            hnswIndex: entry.hnswIndex,
            version: "version" in entry ? entry.version : 1,
            importanceScore: entry.importanceScore,
            domain: entry.domain,
            chatId: entry.chatId,
          });
          const metadata = JSON.stringify(entry.metadata ?? {});
          const embeddingBuf = entry.embedding ? this.embeddingToBuffer(entry.embedding) : null;
          stmt.run(
            entry.id as string,
            entry.type,
            value,
            metadata,
            embeddingBuf,
            entry.createdAt as number,
            Date.now(),
          );
        }
      });

      saveAll();

      getLoggerSafe().info("[AgentDBMemory] Saved all entries to SQLite", {
        count: this.entries.size,
      });
    } catch (error) {
      getLoggerSafe().error("[AgentDBMemory] Failed to save entries to SQLite", {
        error: String(error),
      });
    }
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

      const id = randomUUID();
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
