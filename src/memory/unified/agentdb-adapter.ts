/**
 * AgentDBAdapter — Bridges IUnifiedMemory (AgentDB) to IMemoryManager (orchestrator)
 *
 * Translates method signatures between the two interfaces so the orchestrator
 * works unchanged while using AgentDB as the memory backend.
 *
 * This adapter is intentionally temporary. When the orchestrator migrates to
 * speak IUnifiedMemory directly, this adapter can be removed.
 */

import type {
  IMemoryManager,
  RetrievalOptions,
  RetrievalResult,
  MemoryEntry,
  ConversationMemoryEntry,
  MemoryStats,
  MemoryHealth,
  MemoryImportance,
  MemoryMetadata,
  MemoryEntryType,
  PaginatedRetrievalResult,
  SemanticRetrievalOptions,
  ChatRetrievalOptions,
} from "../memory.interface.js";
import type { StradaProjectAnalysis } from "../../intelligence/strada-analyzer.js";
import type {
  Result,
  Option,
  MemoryId,
  ChatId,
  TimestampMs,
  DurationMs,
  JsonObject,
} from "../../types/index.js";
import { ok, err, some, none } from "../../types/index.js";
import type { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { UserProfileStore } from "./user-profile-store.js";
import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return console;
  }
}

export class AgentDBAdapter implements IMemoryManager {
  constructor(private readonly agentdb: AgentDBMemory) {}

  /** Get the underlying AgentDBMemory instance (for consolidation engine access, Phase 25) */
  getAgentDBMemory(): AgentDBMemory {
    return this.agentdb;
  }

  /** Get the user profile store (returns null if memory not initialized) */
  getUserProfileStore(): UserProfileStore | null {
    return this.agentdb.getUserProfileStore();
  }

  // =========================================================================
  // Lifecycle — pass-through
  // =========================================================================

  async initialize(): Promise<Result<void, Error>> {
    return this.agentdb.initialize();
  }

  async shutdown(): Promise<Result<void, Error>> {
    return this.agentdb.shutdown();
  }

  // =========================================================================
  // Retrieval — signature translation
  // IMemoryManager: retrieve(options: RetrievalOptions) -> Result<RetrievalResult[], Error>
  // IUnifiedMemory: retrieve(query: string, options?: RetrievalOptions) -> RetrievalResult[]
  // =========================================================================

  async retrieve(options: RetrievalOptions): Promise<Result<RetrievalResult[], Error>> {
    try {
      const query = ("query" in options && options.query) ? options.query : "";
      const mode = "mode" in options ? options.mode : undefined;

      // Chat and type modes are structural filters — keep TF-IDF path.
      // All other modes (text, semantic, hybrid) with a non-empty query
      // route through HNSW vector similarity search.
      if (mode === "chat" || mode === "type" || query.length === 0) {
        return ok(await this.agentdb.retrieve(query, options));
      }

      // Thread pre-computed embedding to avoid redundant embedding calls
      const embedding = "embedding" in options ? (options as { embedding?: number[] }).embedding : undefined;
      return ok(await this.agentdb.retrieveSemantic(query, { limit: options.limit, embedding }));
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // Analysis Cache — return type translation
  // IMemoryManager: getCachedAnalysis(...) -> Result<Option<Analysis>, Error>
  // IUnifiedMemory: getCachedAnalysis(...) -> Analysis | null
  // =========================================================================

  async getCachedAnalysis(
    projectPath: string,
    maxAgeMs?: DurationMs,
  ): Promise<Result<Option<StradaProjectAnalysis>, Error>> {
    try {
      const analysis = await this.agentdb.getCachedAnalysis(projectPath, maxAgeMs);
      return ok(analysis ? some(analysis) : none());
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async cacheAnalysis(
    analysis: StradaProjectAnalysis,
    projectPath: string,
    _options?: { ttl?: DurationMs },
  ): Promise<Result<void, Error>> {
    return this.agentdb.cacheAnalysis(analysis, projectPath);
  }

  async invalidateAnalysis(_projectPath: string): Promise<Result<void, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] invalidateAnalysis stub called");
    return ok(undefined);
  }

  // =========================================================================
  // Conversation — parameter shape translation
  // IMemoryManager: storeConversation(chatId, summary, options?) -> Result<MemoryId, Error>
  // IUnifiedMemory: storeConversation(chatId, summary, tags?, tier?) -> MemoryEntry
  // =========================================================================

  async storeConversation(
    chatId: ChatId,
    summary: string,
    options?: {
      tags?: string[];
      importance?: MemoryImportance;
      turnNumber?: number;
      userMessage?: string;
      assistantMessage?: string;
    },
  ): Promise<Result<MemoryId, Error>> {
    try {
      const entry = await this.agentdb.storeConversation(
        chatId,
        summary,
        options?.tags,
        MemoryTier.Working,
        {
          userMessage: options?.userMessage,
          assistantMessage: options?.assistantMessage,
        },
      );
      return ok(entry.id);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async getChatHistory(
    _chatId: ChatId,
    _options?: { limit?: number; before?: TimestampMs },
  ): Promise<Result<ConversationMemoryEntry[], Error>> {
    try {
      const entries = await this.agentdb.getChatHistory(_chatId, _options?.limit);
      const conversations: ConversationMemoryEntry[] = entries
        .filter((e): boolean => e.type === "conversation")
        .map((e) => ({
          id: e.id,
          type: "conversation" as const,
          content: e.content,
          createdAt: e.createdAt,
          accessCount: e.accessCount,
          tags: e.tags,
          importance: e.importance,
          archived: e.archived,
          metadata: e.metadata,
          chatId: ((e as unknown as Record<string, unknown>).chatId as ChatId) ?? _chatId,
          userMessage: ((e.metadata as Record<string, unknown> | undefined)?.userMessage as string) ?? e.content,
          turnNumber: (e as unknown as Record<string, unknown>).turnNumber as number | undefined,
        }));
      return ok(conversations);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // General Memory Storage — stubs (not called in Phase 1)
  // =========================================================================

  async storeNote(
    _content: string,
    _options?: {
      title?: string;
      tags?: string[];
      importance?: MemoryImportance;
      source?: string;
      metadata?: MemoryMetadata;
    },
  ): Promise<Result<MemoryId, Error>> {
    try {
      const entry = await this.agentdb.storeNote(_content, _options?.tags);
      return ok(entry.id);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async storeError(
    _error: Error,
    _context: {
      category: string;
      location?: string;
      chatId?: ChatId;
    },
    _options?: {
      tags?: string[];
      metadata?: MemoryMetadata;
    },
  ): Promise<Result<MemoryId, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] storeError stub called");
    return ok("stub_error_id" as MemoryId);
  }

  async resolveError(_id: MemoryId, _resolution: string): Promise<Result<void, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] resolveError stub called");
    return ok(undefined);
  }

  async storeEntry<T extends MemoryEntry>(
    entry: Omit<T, "id" | "createdAt" | "accessCount">,
  ): Promise<Result<T, Error>> {
    try {
      const result = await this.agentdb.storeEntry(entry as unknown as Parameters<typeof this.agentdb.storeEntry>[0]);
      if (result.kind === "ok") {
        return ok(result.value as T);
      }
      return err(result.error);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async getEntry<T extends MemoryEntry>(id: MemoryId): Promise<Result<Option<T>, Error>> {
    try {
      const result = await this.agentdb.getById(id);
      if (!result || result.kind !== "ok") {
        return ok(none());
      }
      if (result.value.kind === "some") {
        return ok(some(result.value.value as T));
      }
      return ok(none());
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async updateEntry<T extends MemoryEntry>(
    _id: MemoryId,
    _updates: Partial<Omit<T, "id" | "createdAt">>,
  ): Promise<Result<T, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] updateEntry stub called");
    return err(new Error("updateEntry not yet implemented in AgentDBAdapter"));
  }

  async deleteEntry(_id: MemoryId): Promise<Result<boolean, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] deleteEntry stub called");
    return ok(false);
  }

  // =========================================================================
  // Retrieval variants — stubs
  // =========================================================================

  async retrievePaginated(
    _options: RetrievalOptions,
    _pagination: { page: number; pageSize: number; cursor?: string },
  ): Promise<Result<PaginatedRetrievalResult, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] retrievePaginated stub called");
    return ok({
      results: [],
      totalCount: 0,
      page: _pagination.page,
      pageSize: _pagination.pageSize,
      hasMore: false,
    });
  }

  async retrieveSemantic(
    query: string,
    options?: Omit<SemanticRetrievalOptions, "mode" | "query">,
  ): Promise<Result<RetrievalResult[], Error>> {
    try {
      const results = await this.agentdb.retrieveSemantic(query, options);
      return ok(results);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async retrieveFromChat(
    _chatId: ChatId,
    _options?: Omit<ChatRetrievalOptions, "mode" | "chatId">,
  ): Promise<Result<RetrievalResult<ConversationMemoryEntry>[], Error>> {
    try {
      const query = _options?.query ?? "";
      const results = await this.agentdb.retrieve(query, {
        mode: "chat" as const,
        chatId: _chatId,
        limit: _options?.limit,
        query,
      });
      const filtered = results.filter(
        (r): r is RetrievalResult<ConversationMemoryEntry> => r.entry.type === "conversation",
      );
      return ok(filtered);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // Management — stubs
  // =========================================================================

  async archiveOldEntries(_before: TimestampMs): Promise<Result<number, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] archiveOldEntries stub called");
    return ok(0);
  }

  async compact(): Promise<Result<{ freedBytes: number }, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] compact stub called");
    return ok({ freedBytes: 0 });
  }

  // =========================================================================
  // Stats & Health — the 2 core production methods
  // =========================================================================

  getStats(): MemoryStats {
    // UnifiedMemoryStats extends MemoryStats, so this is structurally compatible
    return this.agentdb.getStats();
  }

  /**
   * Synthesize MemoryHealth from AgentDB's getStats() + getIndexHealth().
   * IUnifiedMemory doesn't have getHealth(), but we can construct it.
   */
  getHealth(): MemoryHealth {
    const stats = this.agentdb.getStats();
    const indexHealth = this.agentdb.getIndexHealth();

    const issues: string[] = [...indexHealth.issues];
    const effectiveMax = stats.hnswStats?.maxElements ?? 11100;

    if (stats.totalEntries > effectiveMax * 0.9) {
      issues.push("Memory near capacity");
    }

    let indexStatus: "healthy" | "degraded" | "critical";
    if (indexHealth.isHealthy) {
      indexStatus = "healthy";
    } else if (issues.length > 2) {
      indexStatus = "critical";
    } else {
      indexStatus = "degraded";
    }

    return {
      healthy: issues.length === 0,
      issues,
      storageUsagePercent: effectiveMax > 0 ? (stats.totalEntries / effectiveMax) * 100 : 0,
      indexHealth: indexStatus,
    };
  }

  // =========================================================================
  // Export/Import — stubs
  // =========================================================================

  async export(
    _options?: {
      types?: MemoryEntryType[];
      after?: TimestampMs;
      before?: TimestampMs;
    },
  ): Promise<Result<JsonObject, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] export stub called");
    return ok({} as JsonObject);
  }

  async import(_data: JsonObject): Promise<Result<number, Error>> {
    getLoggerSafe().debug("[AgentDBAdapter] import stub called");
    return ok(0);
  }
}
