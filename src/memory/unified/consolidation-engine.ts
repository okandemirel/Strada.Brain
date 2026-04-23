/**
 * Memory Consolidation Engine
 *
 * Clusters similar memories per tier using HNSW kNN search, summarizes them
 * via LLM, and soft-deletes originals with an audit trail. Supports
 * AbortController interruption (MEM-13), recursive consolidation with depth
 * tracking, undo, and dry-run preview.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ConsolidationConfig,
  ConsolidationPreview,
  ConsolidationResult,
  ConsolidationStats,
  ConsolidationTierStats,
  MemoryCluster,
} from "./consolidation-types.js";
import { MemoryTier } from "./unified-memory.interface.js";

// =============================================================================
// TYPES FOR CONSTRUCTOR DEPENDENCIES
// =============================================================================

// =============================================================================
// CONSOLIDATION STATUS ENUM
// =============================================================================

/**
 * Lifecycle states for a row in the `consolidation_log` table.
 * Exported so callers/tests and dashboard code do not recreate the literal
 * union at each site. Keep in sync with the `status` column default in
 * `ensureSchema()` and the SQL CHECK logic around it.
 */
export type ConsolidationStatus = "pending" | "completed" | "failed" | "undone";

const STATUS_PENDING: ConsolidationStatus = "pending";
const STATUS_COMPLETED: ConsolidationStatus = "completed";

/** Minimal HNSW store interface used by the consolidation engine */
interface HnswStoreContract {
  search(queryVector: number[], topK: number): Promise<Array<{ id: string; score: number }>>;
  remove(ids: string[]): Promise<void>;
  upsert(entries: Array<{ id: string; vector: number[]; chunk: unknown; addedAt: number; accessCount: number }>): Promise<void>;
}

/** Minimal event emitter interface */
interface EventEmitterContract {
  emit(event: string, payload: unknown): void;
}

/** Minimal logger interface */
interface LoggerContract {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/** LLM summarization result */
interface SummarizeResult {
  summary: string;
  cost: number;
  model: string;
}

/** In-memory entry shape (duck-typed for AgentDBMemory entries) */
interface MemoryEntryLike {
  id: string;
  type: string;
  content: string;
  tier: MemoryTier;
  domain?: string;
  importance: string;
  importanceScore: number;
  embedding: number[];
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  metadata: Record<string, unknown>;
  tags: string[];
  archived: boolean;
  chatId: string;
  version?: number;
}

/** Minimal HNSW write mutex interface */
interface HnswWriteMutexContract {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Constructor options for MemoryConsolidationEngine */
export interface ConsolidationEngineOptions {
  sqliteDb: Database.Database;
  entries: Map<string, unknown>;
  hnswStore: unknown;
  hnswWriteMutex?: HnswWriteMutexContract;
  config: ConsolidationConfig;
  generateEmbedding: (text: string) => Promise<number[]>;
  summarizeWithLLM: (contents: string[]) => Promise<SummarizeResult>;
  eventEmitter: EventEmitterContract;
  logger: LoggerContract;
  agentId?: string;
  exemptDomains?: string[];
}

// =============================================================================
// ENGINE
// =============================================================================

export class MemoryConsolidationEngine {
  private readonly db: Database.Database;
  private readonly entries: Map<string, MemoryEntryLike>;
  private readonly hnsw: HnswStoreContract;
  private readonly hnswMutex: HnswWriteMutexContract | null;
  private readonly config: ConsolidationConfig;
  private readonly generateEmbedding: (text: string) => Promise<number[]>;
  private readonly summarizeWithLLM: (contents: string[]) => Promise<SummarizeResult>;
  private readonly emitter: EventEmitterContract;
  private readonly logger: LoggerContract;
  private readonly agentId?: string;
  private readonly exemptDomains: Set<string>;

  // Prepared statements — hoisted from processCluster() so we re-use the
  // compiled plan across every cluster. `ensureSchema()` populates them
  // once, right after the schema is guaranteed.
  private softDeleteStmt!: Database.Statement;
  private insertMemoryStmt!: Database.Statement;
  private insertPendingLogStmt!: Database.Statement;
  private markLogCompletedStmt!: Database.Statement;
  private markLogFailedStmt!: Database.Statement;
  private unflagStmt!: Database.Statement;
  private deleteSummaryStmt!: Database.Statement;
  // NOTE: `db.transaction()` wrappers are intentionally NOT hoisted. The
  // better-sqlite3 runtime already caches transaction plans internally per
  // call site, and hoisting them here would force test mocks (which expose
  // `db.transaction` as a `vi.fn`) to re-implement the "returns a forwarder
  // fn" semantics. The prepared statements alone give us the biggest win.

  constructor(opts: ConsolidationEngineOptions) {
    this.db = opts.sqliteDb;
    this.entries = opts.entries as Map<string, MemoryEntryLike>;
    this.hnsw = opts.hnswStore as HnswStoreContract;
    this.hnswMutex = opts.hnswWriteMutex ?? null;
    this.config = opts.config;
    this.generateEmbedding = opts.generateEmbedding;
    this.summarizeWithLLM = opts.summarizeWithLLM;
    this.emitter = opts.eventEmitter;
    this.logger = opts.logger;
    this.agentId = opts.agentId;
    // Always exempt instincts; merge with provided exempt domains
    this.exemptDomains = new Set(["instinct", ...(opts.exemptDomains ?? [])]);

    this.ensureSchema();
    // Startup janitor — fail orphan 'pending' rows from a prior crash so they
    // are never confused with an in-flight consolidation (see
    // `markStalePendingFailed`). Runs inline during construction because
    // callers always instantiate through `new MemoryConsolidationEngine(...)`
    // before the heartbeat loop kicks in.
    this.markStalePendingFailed();
  }

  // ---------------------------------------------------------------------------
  // STARTUP JANITOR
  // ---------------------------------------------------------------------------

  /**
   * Two-phase commit protection: Phase 1 writes a `pending` row BEFORE Phase 2
   * mutations. If the process crashes between Phase 1 and Phase 2/3 completion,
   * the `pending` row is orphaned and there is no in-flight cluster to finalize.
   *
   * Flip all `pending` rows older than 1h to `failed` so downstream tooling
   * (dashboards, `getStats()`, undo listings) do not treat them as live.
   *
   * Returns the count of rows transitioned for logging/tests.
   */
  markStalePendingFailed(staleWindowMs: number = 60 * 60 * 1000): number {
    try {
      const cutoff = Date.now() - staleWindowMs;
      const rows = this.db
        .prepare("SELECT id FROM consolidation_log WHERE status = 'pending' AND timestamp < ?")
        .all(cutoff) as Array<{ id: string }>;
      if (rows.length === 0) return 0;

      const updateStmt = this.db.prepare(
        "UPDATE consolidation_log SET status = 'failed' WHERE id = ? AND status = 'pending'",
      );
      for (const row of rows) {
        updateStmt.run(row.id);
      }

      this.logger.warn("[Consolidation] Marked stale pending log rows as failed", {
        count: rows.length,
        cutoff,
      });
      return rows.length;
    } catch (error) {
      this.logger.error("[Consolidation] Startup janitor failed", {
        error: String(error),
      });
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // SCHEMA
  // ---------------------------------------------------------------------------

  private ensureSchema(): void {
    // Add consolidation columns to memories table (idempotent)
    const cols = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (!colNames.has("consolidated_into")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN consolidated_into TEXT");
    }
    if (!colNames.has("consolidated_at")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN consolidated_at INTEGER");
    }

    // Create consolidation log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_log (
        id TEXT PRIMARY KEY,
        summary_entry_id TEXT NOT NULL,
        source_entry_ids TEXT NOT NULL,
        similarity_score REAL NOT NULL,
        model_used TEXT NOT NULL,
        cost REAL NOT NULL DEFAULT 0.0,
        timestamp INTEGER NOT NULL,
        depth INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'completed',
        agent_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_consolidation_log_timestamp ON consolidation_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_consolidation_log_status ON consolidation_log(status);
    `);

    // Index on memories.consolidated_into for fast filtering in findClusters
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_consolidated_into ON memories(consolidated_into);");

    // Prepared statements — one-shot compile, reused per processCluster call.
    this.softDeleteStmt = this.db.prepare(
      "UPDATE memories SET consolidated_into = ?, consolidated_at = ?, value = json_set(value, '$.consolidated_into', ?, '$.consolidated_at', ?), updated_at = ? WHERE id = ?",
    );
    this.insertMemoryStmt = this.db.prepare(
      "INSERT OR REPLACE INTO memories (id, key, value, metadata, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.insertPendingLogStmt = this.db.prepare(
      "INSERT INTO consolidation_log (id, summary_entry_id, source_entry_ids, similarity_score, model_used, cost, timestamp, depth, status, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.markLogCompletedStmt = this.db.prepare(
      "UPDATE consolidation_log SET status = 'completed' WHERE id = ?",
    );
    this.markLogFailedStmt = this.db.prepare(
      "UPDATE consolidation_log SET status = 'failed' WHERE id = ?",
    );
    this.unflagStmt = this.db.prepare(
      "UPDATE memories SET consolidated_into = NULL, consolidated_at = NULL, value = json_remove(value, '$.consolidated_into', '$.consolidated_at'), updated_at = ? WHERE id = ?",
    );
    this.deleteSummaryStmt = this.db.prepare(
      "DELETE FROM memories WHERE id = ?",
    );
  }

  // ---------------------------------------------------------------------------
  // CLUSTERING
  // ---------------------------------------------------------------------------

  /**
   * Find clusters of similar entries within a single tier.
   * Uses HNSW kNN search per eligible entry, building clusters from
   * overlapping neighbor sets above the similarity threshold.
   */
  async findClusters(tier: MemoryTier): Promise<MemoryCluster[]> {
    const now = Date.now();
    const visited = new Set<string>();
    const clusters: MemoryCluster[] = [];

    // Bulk-read all consolidated IDs to avoid N² per-entry SQLite queries
    const consolidatedIds = new Set<string>(
      (this.db.prepare("SELECT id FROM memories WHERE consolidated_into IS NOT NULL").all() as Array<{ id: string }>)
        .map((r) => r.id),
    );

    // Collect eligible entries for this tier
    const eligible: MemoryEntryLike[] = [];
    for (const entry of this.entries.values()) {
      if (entry.tier !== tier) continue;
      if (this.isExempt(entry)) continue;
      if (this.getDepth(entry) >= this.config.maxDepth) continue;
      if (now - entry.createdAt < this.config.minAgeMs) continue;
      if (consolidatedIds.has(entry.id)) continue;
      eligible.push(entry);
    }

    for (const entry of eligible) {
      if (visited.has(entry.id)) continue;
      if (!entry.embedding || entry.embedding.length === 0) continue;

      const neighbors = await this.hnsw.search(
        entry.embedding,
        this.config.batchSize,
      );

      // Filter neighbors: same tier, above threshold, eligible, not visited
      const clusterMembers: string[] = [entry.id];
      let totalSimilarity = 0;
      let scoreCount = 0;

      for (const neighbor of neighbors) {
        if (neighbor.id === entry.id) continue;
        if (visited.has(neighbor.id)) continue;
        if (neighbor.score < this.config.threshold) continue;

        const neighborEntry = this.entries.get(neighbor.id);
        if (!neighborEntry) continue;
        if (neighborEntry.tier !== tier) continue;
        if (this.isExempt(neighborEntry)) continue;
        if (this.getDepth(neighborEntry) >= this.config.maxDepth) continue;
        if (now - neighborEntry.createdAt < this.config.minAgeMs) continue;
        if (consolidatedIds.has(neighborEntry.id)) continue;

        clusterMembers.push(neighbor.id);
        totalSimilarity += neighbor.score;
        scoreCount++;
      }

      if (clusterMembers.length >= this.config.minClusterSize) {
        const avgSimilarity = scoreCount > 0 ? totalSimilarity / scoreCount : 0;
        for (const id of clusterMembers) {
          visited.add(id);
        }
        clusters.push({
          seedId: entry.id,
          memberIds: clusterMembers,
          avgSimilarity,
          tier,
        });
      }
    }

    // Sort by highest avg similarity first (interruption-resilient ordering)
    clusters.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
    return clusters;
  }

  // ---------------------------------------------------------------------------
  // PROCESS CLUSTER
  // ---------------------------------------------------------------------------

  /**
   * Process a single cluster: summarize via LLM, soft-delete originals,
   * insert summary entry, log the operation. All in a single SQLite transaction.
   * @throws if embedding generation fails (caller should catch and skip)
   */
  async processCluster(cluster: MemoryCluster): Promise<{ cost: number }> {
    // Gather content from entries
    const memberEntries = cluster.memberIds
      .map((id) => this.entries.get(id))
      .filter((e): e is MemoryEntryLike => e !== undefined);

    const contents = memberEntries.map((e) => e.content);

    // Summarize via LLM
    const llmResult = await this.summarizeWithLLM(contents);

    // Generate embedding for summary text (throws on failure)
    const summaryEmbedding = await this.generateEmbedding(llmResult.summary);

    // Calculate depth and importance
    const maxDepth = Math.max(...memberEntries.map((e) => this.getDepth(e)));
    const newDepth = maxDepth + 1;
    const maxImportanceScore = Math.max(...memberEntries.map((e) => e.importanceScore));

    // Create summary entry
    const summaryId = randomUUID();
    const now = Date.now();
    const logId = randomUUID();

    const summaryMetadata: Record<string, unknown> = {
      consolidation: {
        sourceIds: cluster.memberIds,
        depth: newDepth,
        consolidatedAt: now,
        originalCount: cluster.memberIds.length,
        avgSimilarity: cluster.avgSimilarity,
        logId,
      },
    };

    const summaryEntry: MemoryEntryLike = {
      id: summaryId,
      type: "note",
      content: llmResult.summary,
      tier: cluster.tier,
      importance: "medium",
      importanceScore: maxImportanceScore,
      embedding: summaryEmbedding,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      metadata: summaryMetadata,
      tags: [],
      archived: false,
      chatId: memberEntries[0]?.chatId ?? "default",
    };

    // =========================================================================
    // TWO-PHASE COMMIT
    // =========================================================================
    // Atomicity strategy (prevents orphan summary + stale HNSW vectors):
    //   Phase 1 (Intent):   Insert consolidation_log row with status='pending'
    //                       BEFORE mutating memories. Serves as crash-recovery
    //                       marker + persistent transaction log.
    //   Phase 2 (SQL):      Single SQLite transaction: soft-delete members +
    //                       insert summary. Atomic by SQLite guarantee.
    //   Phase 3 (HNSW):     Under writeMutex, perform HNSW.remove(members) +
    //                       HNSW.upsert(summary). On success -> log status
    //                       transitions 'pending' -> 'completed'. On failure ->
    //                       compensating SQL transaction unflags members +
    //                       deletes summary + marks log status='failed'.
    //   Phase 3 runs INSIDE the mutex so concurrent storeEntry() writes to
    //   HNSW are FIFO-ordered relative to the consolidation HNSW mutation
    //   AND the compensating SQL rollback.
    // =========================================================================
    // Prepared statements live on the instance (see ensureSchema()) so the
    // compile/plan cost is paid once, not per-cluster.
    const softDeleteStmt = this.softDeleteStmt;
    const insertStmt = this.insertMemoryStmt;
    const insertPendingLogStmt = this.insertPendingLogStmt;
    const markLogCompletedStmt = this.markLogCompletedStmt;
    const markLogFailedStmt = this.markLogFailedStmt;
    const unflagStmt = this.unflagStmt;
    const deleteSummaryStmt = this.deleteSummaryStmt;

    const summaryValue = JSON.stringify({
      type: summaryEntry.type,
      content: summaryEntry.content,
      tags: summaryEntry.tags,
      importance: summaryEntry.importance,
      tier: summaryEntry.tier,
      accessCount: summaryEntry.accessCount,
      lastAccessedAt: summaryEntry.lastAccessedAt,
      importanceScore: summaryEntry.importanceScore,
      domain: summaryEntry.domain,
      chatId: summaryEntry.chatId,
      version: 1,
    });
    const summaryMetaStr = JSON.stringify(summaryMetadata);
    const summaryEmbBuf = Buffer.from(new Float32Array(summaryEmbedding).buffer);

    // Phase 1: persistent intent log (status='pending') — written BEFORE
    // any memory mutation so crashes leave a recoverable trace.
    insertPendingLogStmt.run(
      logId,
      summaryId,
      JSON.stringify(cluster.memberIds),
      cluster.avgSimilarity,
      llmResult.model,
      llmResult.cost,
      now,
      newDepth,
      STATUS_PENDING,
      this.agentId ?? null,
    );

    // Phase 2: atomic SQLite transaction — soft-delete + insert summary.
    this.db.transaction(() => {
      // Soft-delete originals (SQL columns + JSON blob for audit trail)
      for (const id of cluster.memberIds) {
        softDeleteStmt.run(summaryId, now, summaryId, now, now, id);
      }

      // Insert summary entry
      insertStmt.run(
        summaryId,
        "note",
        summaryValue,
        summaryMetaStr,
        summaryEmbBuf,
        now,
        now,
      );
    })();

    // Phase 3: HNSW mutation + log finalization — wrapped in the write
    // mutex. On HNSW failure, compensating SQL transaction rolls back the
    // Phase 2 mutations and marks the log 'failed'. The mutex guarantees
    // FIFO ordering against concurrent storeEntry() callers.
    const doHnswAndFinalize = async (): Promise<void> => {
      try {
        await this.hnsw.remove(cluster.memberIds);
        await this.hnsw.upsert([{
          id: summaryId,
          vector: summaryEmbedding,
          chunk: { filePath: "", content: llmResult.summary, kind: "generic", language: "text" },
          addedAt: now,
          accessCount: 0,
        }]);
        // Transition 'pending' -> 'completed' only after HNSW succeeded.
        markLogCompletedStmt.run(logId);
      } catch (hnswError) {
        this.logger.error(
          "[Consolidation] HNSW update failed, rolling back SQLite commit",
          {
            summaryId,
            memberIds: cluster.memberIds,
            error: String(hnswError),
          },
        );

        // Compensating transaction: reverse Phase 2 + mark log 'failed'.
        // Runs inside the mutex so no concurrent writer observes a
        // partial rollback state on the HNSW side.
        this.db.transaction(() => {
          for (const id of cluster.memberIds) {
            unflagStmt.run(now, id);
          }
          deleteSummaryStmt.run(summaryId);
          markLogFailedStmt.run(logId);
        })();

        throw hnswError;
      }
    };

    if (this.hnswMutex) {
      await this.hnswMutex.withLock(doHnswAndFinalize);
    } else {
      await doHnswAndFinalize();
    }

    // Update in-memory entries only after both SQLite and HNSW succeed
    for (const id of cluster.memberIds) {
      this.entries.delete(id);
    }
    this.entries.set(summaryId, summaryEntry);

    this.logger.debug("[Consolidation] Processed cluster", {
      clusterId: cluster.seedId,
      members: cluster.memberIds.length,
      summaryId,
      depth: newDepth,
    });

    return { cost: llmResult.cost };
  }

  // ---------------------------------------------------------------------------
  // RUN CYCLE
  // ---------------------------------------------------------------------------

  /**
   * Run a full consolidation cycle across all tiers.
   * Checks AbortSignal between each cluster for MEM-13 interruption.
   */
  async runCycle(signal: AbortSignal): Promise<ConsolidationResult> {
    this.emitter.emit("consolidation:started", { timestamp: Date.now() });

    const allClusters = await this.findAllClusters();

    if (allClusters.length === 0) {
      this.emitter.emit("consolidation:completed", { processed: 0, timestamp: Date.now() });
      return {
        status: "skipped",
        processed: 0,
        remaining: 0,
        clustersFound: 0,
        costUsd: 0,
      };
    }

    let processed = 0;
    let totalCost = 0;

    for (let i = 0; i < allClusters.length; i++) {
      // Check for interruption BEFORE processing
      if (signal.aborted) {
        const remaining = allClusters.length - i;
        this.emitter.emit("consolidation:interrupted", {
          processed,
          remaining,
          timestamp: Date.now(),
        });
        return {
          status: "interrupted",
          processed,
          remaining,
          clustersFound: allClusters.length,
          costUsd: totalCost,
        };
      }

      try {
        const result = await this.processCluster(allClusters[i]!);
        totalCost += result.cost;
        processed++;
      } catch (error) {
        // Embedding or other failure: skip cluster, log warning
        this.logger.warn("[Consolidation] Skipped cluster due to error", {
          clusterId: allClusters[i]!.seedId,
          error: String(error),
        });
      }
    }

    this.emitter.emit("consolidation:completed", {
      processed,
      costUsd: totalCost,
      timestamp: Date.now(),
    });

    return {
      status: "completed",
      processed,
      remaining: 0,
      clustersFound: allClusters.length,
      costUsd: totalCost,
    };
  }

  // ---------------------------------------------------------------------------
  // PREVIEW (DRY-RUN)
  // ---------------------------------------------------------------------------

  /**
   * Return clusters and estimated cost without modifying anything.
   */
  async preview(): Promise<ConsolidationPreview> {
    const allClusters = await this.findAllClusters();

    // Estimate cost per cluster based on average content length
    // Rough estimate: ~$0.001 per 1000 tokens, ~4 chars per token
    const estimatedCostPerCluster = allClusters.length > 0
      ? allClusters.reduce((sum, cluster) => {
          const totalChars = cluster.memberIds.reduce((s, id) => {
            const entry = this.entries.get(id);
            return s + (entry?.content.length ?? 0);
          }, 0);
          return sum + (totalChars / 4000) * 0.001;
        }, 0) / allClusters.length
      : 0;

    return {
      clusters: allClusters,
      estimatedCostPerCluster,
      totalEstimatedCost: estimatedCostPerCluster * allClusters.length,
    };
  }

  // ---------------------------------------------------------------------------
  // UNDO
  // ---------------------------------------------------------------------------

  /**
   * Undo a consolidation: restore originals, delete summary, rebuild HNSW vectors.
   * @throws if log entry not found or not in "completed" status
   */
  undo(logId: string): void {
    const logRow = this.db.prepare(
      "SELECT * FROM consolidation_log WHERE id = ?",
    ).get(logId) as Record<string, unknown> | undefined;

    if (!logRow) {
      throw new Error(`Consolidation log entry not found: ${logId}`);
    }
    if (logRow.status !== STATUS_COMPLETED) {
      throw new Error(`Cannot undo consolidation with status '${logRow.status}'. Only '${STATUS_COMPLETED}' entries can be undone.`);
    }

    const summaryEntryId = logRow.summary_entry_id as string;
    const sourceEntryIds = JSON.parse(logRow.source_entry_ids as string) as string[];

    // Unflag originals (remove consolidated_into and consolidated_at from value JSON)
    const unflagStmt = this.db.prepare(
      "UPDATE memories SET consolidated_into = NULL, consolidated_at = NULL, value = json_remove(value, '$.consolidated_into', '$.consolidated_at'), updated_at = ? WHERE id = ?",
    );

    const deleteSummaryStmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
    const markUndoneStmt = this.db.prepare(
      "UPDATE consolidation_log SET status = 'undone' WHERE id = ?",
    );

    // Read original entries' embeddings before transaction for HNSW rebuild
    const originalEmbeddings: Array<{ id: string; embedding: number[] }> = [];
    for (const id of sourceEntryIds) {
      const row = this.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(id) as { embedding: Buffer | null } | undefined;
      if (row?.embedding) {
        const floats = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
        originalEmbeddings.push({ id, embedding: Array.from(floats) });
      }
    }

    const now = Date.now();

    this.db.transaction(() => {
      // Unflag originals
      for (const id of sourceEntryIds) {
        unflagStmt.run(now, id);
      }

      // Delete summary entry
      deleteSummaryStmt.run(summaryEntryId);

      // Mark log as undone
      markUndoneStmt.run(logId);
    })();

    // Update in-memory entries: restore originals, remove summary
    this.entries.delete(summaryEntryId);

    // Restore originals to in-memory map by reading from DB
    for (const id of sourceEntryIds) {
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (row) {
        const parsed = JSON.parse(row.value as string) as Record<string, unknown>;
        const metadata = JSON.parse(row.metadata as string ?? "{}") as Record<string, unknown>;
        const embBuf = row.embedding as Buffer | null;
        const embedding = embBuf
          ? Array.from(new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4))
          : [];

        this.entries.set(id, {
          id,
          type: parsed.type as string ?? "note",
          content: parsed.content as string ?? "",
          tier: (parsed.tier as MemoryTier) ?? MemoryTier.Ephemeral,
          domain: parsed.domain as string | undefined,
          importance: parsed.importance as string ?? "medium",
          importanceScore: (parsed.importanceScore as number) ?? 0.5,
          embedding,
          createdAt: row.created_at as number,
          lastAccessedAt: (parsed.lastAccessedAt as number) ?? (row.created_at as number),
          accessCount: (parsed.accessCount as number) ?? 0,
          metadata,
          tags: (parsed.tags as string[]) ?? [],
          archived: (parsed.archived as boolean) ?? false,
          chatId: (parsed.chatId as string) ?? "default",
          version: (parsed.version as number) ?? 1,
        });
      }
    }

    // HNSW updates: remove summary vector, re-add original vectors.
    // Acquire the write mutex to prevent interleaved writes.
    // Use .catch() to log errors (undo is sync but HNSW ops are async).
    const doUndoHnsw = async (): Promise<void> => {
      await this.hnsw.remove([summaryEntryId]);
      if (originalEmbeddings.length > 0) {
        await this.hnsw.upsert(
          originalEmbeddings.map((oe) => ({
            id: oe.id,
            vector: oe.embedding,
            chunk: { filePath: "", content: "", kind: "generic", language: "text" },
            addedAt: now,
            accessCount: 0,
          })),
        );
      }
    };
    const hnswPromise = this.hnswMutex
      ? this.hnswMutex.withLock(doUndoHnsw)
      : doUndoHnsw();
    void hnswPromise.catch((err) => {
      this.logger.warn("[Consolidation] HNSW update failed during undo", { error: String(err) });
    });

    this.logger.info("[Consolidation] Undo completed", { logId, summaryEntryId, restoredCount: sourceEntryIds.length });
  }

  // ---------------------------------------------------------------------------
  // STATS
  // ---------------------------------------------------------------------------

  /**
   * Get consolidation statistics: per-tier breakdown and lifetime totals.
   */
  getStats(): ConsolidationStats {
    const perTier: Record<string, ConsolidationTierStats> = {};

    for (const tier of MemoryConsolidationEngine.ALL_TIERS) {
      const total = Array.from(this.entries.values()).filter((e) => e.tier === tier).length;
      // Count clustered = entries with consolidated_into set in this tier
      const clusteredRow = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM memories WHERE consolidated_into IS NOT NULL AND json_extract(value, '$.tier') = ?",
      ).get(tier) as { cnt: number };
      const clustered = clusteredRow.cnt;
      perTier[tier] = { clustered, pending: total, total: total + clustered };
    }

    // Lifetime stats from consolidation_log
    const statsRow = this.db.prepare(
      "SELECT COUNT(*) as totalRuns, COALESCE(SUM(cost), 0) as totalCost FROM consolidation_log WHERE status = 'completed'",
    ).get() as { totalRuns: number; totalCost: number };

    // Lifetime savings: total source entries consolidated minus summary entries created
    const savingsRow = this.db.prepare(
      "SELECT COALESCE(SUM(json_array_length(source_entry_ids) - 1), 0) as savings FROM consolidation_log WHERE status = 'completed'",
    ).get() as { savings: number };

    return {
      perTier,
      lifetimeSavings: savingsRow.savings,
      totalRuns: statsRow.totalRuns,
      totalCostUsd: statsRow.totalCost,
    };
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  /** All memory tiers in processing order */
  private static readonly ALL_TIERS = [MemoryTier.Working, MemoryTier.Ephemeral, MemoryTier.Persistent] as const;

  /** Find clusters across all tiers, sorted by highest similarity first */
  private async findAllClusters(): Promise<MemoryCluster[]> {
    const clusters: MemoryCluster[] = [];
    for (const tier of MemoryConsolidationEngine.ALL_TIERS) {
      const tierClusters = await this.findClusters(tier);
      clusters.push(...tierClusters);
    }
    clusters.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
    return clusters;
  }

  /** Check if an entry is exempt from consolidation */
  private isExempt(entry: MemoryEntryLike): boolean {
    return entry.domain !== undefined && this.exemptDomains.has(entry.domain);
  }

  /** Get the consolidation depth of an entry (0 if never consolidated) */
  private getDepth(entry: MemoryEntryLike): number {
    const meta = entry.metadata?.consolidation as Record<string, unknown> | undefined;
    return (meta?.depth as number) ?? 0;
  }

  // isConsolidated removed — replaced by bulk Set<string> lookup in findClusters
}
