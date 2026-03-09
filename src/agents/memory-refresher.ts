/**
 * MemoryRefresher -- Dynamic memory re-retrieval engine (Phase 17)
 *
 * Provides:
 * - Periodic re-retrieval every N iterations
 * - Topic shift detection via cosine distance
 * - Parallel retrieval from memory, RAG, and instinct sources
 * - Content-hash deduplication to prevent injecting identical context
 * - Budget enforcement (max re-retrievals per conversation)
 * - Non-fatal failure handling with configurable timeout
 * - Event emission for observability
 */

import { createHash } from "node:crypto";
import type { ReRetrievalConfig } from "../config/config.js";
import type { IEventEmitter } from "../core/event-bus.js";
import type { IMemoryManager, RetrievalOptions, RetrievalResult } from "../memory/memory.interface.js";
import type { IRAGPipeline, SearchResult, SearchOptions, IEmbeddingProvider } from "../rag/rag.interface.js";
import type { InsightResult, InstinctRetriever } from "./instinct-retriever.js";
import { denseCosineSimilarity } from "../rag/vector-math.js";

// =============================================================================
// TYPES
// =============================================================================

/** Dependencies injected into MemoryRefresher (all optional for graceful degradation) */
export interface MemoryRefresherDeps {
  readonly memoryManager?: IMemoryManager;
  readonly ragPipeline?: IRAGPipeline;
  readonly instinctRetriever?: InstinctRetriever;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly eventBus?: IEventEmitter;
}

/** Reason for re-retrieval decision */
export type RefreshReason = "periodic" | "topic_shift" | "budget_exhausted" | "none" | "skipped";

/** Result from shouldRefresh check */
export interface ShouldRefreshResult {
  readonly should: boolean;
  readonly reason: RefreshReason;
}

/** Result from a refresh() call */
export interface RefreshResult {
  readonly triggered: boolean;
  readonly reason: RefreshReason;
  readonly newMemoryContext?: string;
  readonly newRagContext?: string;
  readonly newInsights?: string[];
  readonly newInstinctIds?: string[];
  readonly durationMs: number;
  readonly retrievalNumber: number;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class MemoryRefresher {
  private retrievalCount = 0;
  private lastRetrievalIteration = 0;
  private lastTopicEmbedding: number[] | null = null;
  private readonly injectedContentHashes = new Set<string>();
  private budgetExhaustedLogged = false;

  constructor(
    private readonly config: ReRetrievalConfig,
    private readonly deps: MemoryRefresherDeps,
  ) {}

  /**
   * Check whether a re-retrieval should be triggered.
   */
  async shouldRefresh(
    iteration: number,
    recentContext: string,
    sessionId: string,
  ): Promise<ShouldRefreshResult> {
    if (!this.config.enabled) {
      return { should: false, reason: "none" };
    }

    if (this.retrievalCount >= this.config.maxReRetrievals) {
      if (!this.budgetExhaustedLogged) {
        this.budgetExhaustedLogged = true;
        this.logDebug(`Re-retrieval budget exhausted (${this.config.maxReRetrievals} max) for session ${sessionId}`);
      }
      return { should: false, reason: "budget_exhausted" };
    }

    // Topic shift detection
    if (this.config.topicShiftEnabled && this.deps.embeddingProvider) {
      try {
        const batch = await this.deps.embeddingProvider.embed([recentContext]);
        const embedding = batch.embeddings[0];
        if (embedding && embedding.length > 0) {
          const current = Array.isArray(embedding) ? embedding : Array.from(embedding as ArrayLike<number>);
          if (this.lastTopicEmbedding) {
            const similarity = denseCosineSimilarity(current, this.lastTopicEmbedding);
            const distance = 1 - similarity;
            if (distance > this.config.topicShiftThreshold) {
              // Store the new embedding for future comparisons
              this.lastTopicEmbedding = current;
              return { should: true, reason: "topic_shift" };
            }
          }
          // Update embedding for next comparison (first call or within threshold)
          this.lastTopicEmbedding = current;
        }
        // null/empty embedding: skip topic shift (known Gemini issue)
      } catch {
        // Embedding failure is non-fatal: skip topic shift detection
        this.logDebug("Topic shift embedding failed, skipping");
      }
    }

    // Periodic check
    if (iteration >= this.lastRetrievalIteration + this.config.interval) {
      return { should: true, reason: "periodic" };
    }

    return { should: false, reason: "none" };
  }

  /**
   * Execute a re-retrieval: fetch from memory, RAG, and instincts in parallel,
   * deduplicate, emit events, and return new context.
   */
  async refresh(
    query: string,
    sessionId: string,
    reason: RefreshReason = "periodic",
    iteration: number = 0,
  ): Promise<RefreshResult> {
    const start = Date.now();
    const retrievalNumber = this.retrievalCount + 1;

    try {
      // Wrap with timeout via Promise.race; clear timer on completion to avoid leaked handles
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<RefreshResult>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Re-retrieval timed out after ${this.config.timeoutMs}ms`)),
          this.config.timeoutMs,
        );
      });
      try {
        const result = await Promise.race([
          this.doRefresh(query, sessionId, reason, iteration),
          timeoutPromise,
        ]);
        return result;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (error) {
      // Non-fatal: return failure result
      this.logWarn(`Re-retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        triggered: false,
        reason: "skipped",
        durationMs: Date.now() - start,
        retrievalNumber,
      };
    }
  }

  /**
   * Seed initial content hashes so that already-injected context is not re-injected.
   * Call after initial memory/RAG retrieval with the content strings.
   */
  seedContentHashes(texts: string[]): void {
    for (const text of texts) {
      if (text) {
        this.injectedContentHashes.add(this.contentHash(text));
      }
    }
  }

  /**
   * Reset all state (for new conversation/session).
   */
  reset(): void {
    this.retrievalCount = 0;
    this.lastRetrievalIteration = 0;
    this.lastTopicEmbedding = null;
    this.injectedContentHashes.clear();
    this.budgetExhaustedLogged = false;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async doRefresh(
    query: string,
    sessionId: string,
    reason: RefreshReason,
    iteration: number,
  ): Promise<RefreshResult> {
    const start = Date.now();
    const retrievalNumber = this.retrievalCount + 1;

    // Run all retrievals in parallel via Promise.allSettled
    const [memoryResult, ragResult, insightResult] = await Promise.allSettled([
      this.deps.memoryManager
        ? this.deps.memoryManager.retrieve({
            mode: "text",
            query,
            limit: this.config.memoryLimit,
            minScore: 0.15,
          } as RetrievalOptions)
        : Promise.resolve(null),

      this.deps.ragPipeline
        ? this.deps.ragPipeline.search(query, {
            topK: this.config.ragTopK,
            minScore: 0.2,
          } as SearchOptions)
        : Promise.resolve(null),

      this.deps.instinctRetriever
        ? this.deps.instinctRetriever.getInsightsForTask(query)
        : Promise.resolve(null),
    ]);

    // Process memory results with dedup
    let newMemoryContext: string | undefined;
    let newMemoryCount = 0;
    if (memoryResult.status === "fulfilled" && memoryResult.value) {
      const results = memoryResult.value;
      // IMemoryManager.retrieve returns Result<RetrievalResult[], Error>
      const entries = (results as { kind: string; value?: RetrievalResult[] }).kind === "ok"
        ? ((results as { kind: string; value: RetrievalResult[] }).value ?? [])
        : Array.isArray(results) ? results as RetrievalResult[] : [];
      const deduped = entries.filter((r) => {
        const hash = this.contentHash(r.entry.content);
        if (this.injectedContentHashes.has(hash)) return false;
        this.injectedContentHashes.add(hash);
        return true;
      });
      if (deduped.length > 0) {
        newMemoryContext = deduped.map((r) => r.entry.content).join("\n---\n");
        newMemoryCount = deduped.length;
      }
    }

    // Process RAG results with dedup
    let newRagContext: string | undefined;
    let newRagCount = 0;
    if (ragResult.status === "fulfilled" && ragResult.value) {
      const results = ragResult.value as SearchResult[];
      const deduped = results.filter((r) => {
        const hash = this.contentHash(r.chunk.content);
        if (this.injectedContentHashes.has(hash)) return false;
        this.injectedContentHashes.add(hash);
        return true;
      });
      if (deduped.length > 0) {
        newRagContext = this.deps.ragPipeline
          ? this.deps.ragPipeline.formatContext(deduped)
          : deduped.map((r) => r.chunk.content).join("\n---\n");
        newRagCount = deduped.length;
      }
    }

    // Process instinct results with dedup
    let newInsights: string[] | undefined;
    let newInstinctIds: string[] | undefined;
    let newInsightCount = 0;
    if (insightResult.status === "fulfilled" && insightResult.value) {
      const result = insightResult.value as InsightResult;
      const dedupedInsights = result.insights.filter((insight) => {
        const hash = this.contentHash(insight);
        if (this.injectedContentHashes.has(hash)) return false;
        this.injectedContentHashes.add(hash);
        return true;
      });
      if (dedupedInsights.length > 0) {
        newInsights = dedupedInsights;
        newInstinctIds = result.matchedInstinctIds;
        newInsightCount = dedupedInsights.length;
      }
    }

    // Update state
    this.retrievalCount++;
    this.lastRetrievalIteration = iteration;

    const durationMs = Date.now() - start;

    // Emit events
    if (this.deps.eventBus) {
      this.deps.eventBus.emit("memory:re_retrieved", {
        sessionId,
        reason: reason === "topic_shift" ? "topic_shift" : "periodic",
        newMemoryCount,
        newRagCount,
        newInsightCount,
        durationMs,
        retrievalNumber,
        timestamp: Date.now(),
      });

      if (reason === "topic_shift") {
        this.deps.eventBus.emit("memory:topic_shifted", {
          sessionId,
          cosineDistance: 0, // Caller can provide more detail via shouldRefresh
          threshold: this.config.topicShiftThreshold,
          previousTopic: query,
          currentTopic: query,
          timestamp: Date.now(),
        });
      }
    }

    return {
      triggered: true,
      reason,
      newMemoryContext,
      newRagContext,
      newInsights,
      newInstinctIds,
      durationMs,
      retrievalNumber,
    };
  }

  /** SHA-256 content hash truncated to 16 hex chars (matches rag-pipeline.ts pattern) */
  private contentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private logDebug(message: string): void {
    try {
      void import("../utils/logger.js").then(({ getLogger }) => {
        getLogger().debug(`MemoryRefresher: ${message}`);
      }).catch(() => {/* Logger unavailable */});
    } catch {/* Logger unavailable */}
  }

  private logWarn(message: string): void {
    try {
      void import("../utils/logger.js").then(({ getLogger }) => {
        getLogger().warn(`MemoryRefresher: ${message}`);
      }).catch(() => {/* Logger unavailable */});
    } catch {/* Logger unavailable */}
  }
}
