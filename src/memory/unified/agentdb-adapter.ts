/**
 * AgentDBAdapter — Bridges IUnifiedMemory (AgentDB) to IMemoryManager (orchestrator)
 *
 * Translates method signatures between the two interfaces so the orchestrator
 * works unchanged while using AgentDB as the memory backend.
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
import { ok, err, some, none, createBrand } from "../../types/index.js";
import type { AgentDBMemory } from "./agentdb-memory.js";
import { MemoryTier } from "./unified-memory.interface.js";
import type { UserProfileStore } from "./user-profile-store.js";
import type { TaskExecutionStore } from "./task-execution-store.js";

type MutableMetadata = Record<string, JsonObject | string | number | boolean | null | undefined>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableMemoryEntry = MemoryEntry extends infer T
  ? T extends MemoryEntry
    ? Mutable<T>
    : never
  : never;

type AdapterInternalEntry = MutableMemoryEntry & {
  type: MemoryEntryType;
  metadata: MemoryMetadata;
  chatId?: ChatId;
  domain?: string;
  tier?: MemoryTier;
  importanceScore?: number;
  lastAccessedAt?: TimestampMs;
  userMessage?: string;
  assistantMessage?: string;
  turnNumber?: number;
  projectPath?: string;
  category?: string;
  version?: string;
  analysisVersion?: string;
  title?: string;
  source?: string;
  errorCategory?: string;
  errorCode?: string;
  location?: string;
  resolved?: boolean;
  resolution?: string;
  command?: string;
  workingDirectory?: string;
  exitCode?: number;
  success?: boolean;
  task?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  parentTaskId?: MemoryId;
  dueDate?: TimestampMs;
};

type AgentDBAdapterInternals = {
  cachedAnalysis: { projectPath: string; analysis: StradaProjectAnalysis } | null;
  persistEntry: (entry: AdapterInternalEntry) => void;
};

const MEMORY_TIERS = [MemoryTier.Working, MemoryTier.Ephemeral, MemoryTier.Persistent] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMutableMetadata(metadata: MemoryMetadata | undefined): MutableMetadata {
  return isRecord(metadata) ? { ...metadata } as MutableMetadata : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isMemoryImportance(value: unknown): value is MemoryImportance {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isMemoryEntryType(value: unknown): value is MemoryEntryType {
  return value === "conversation"
    || value === "analysis"
    || value === "note"
    || value === "command"
    || value === "error"
    || value === "insight"
    || value === "task";
}

function importanceToScore(importance: MemoryImportance): number {
  switch (importance) {
    case "low":
      return 0.25;
    case "medium":
      return 0.5;
    case "high":
      return 0.8;
    case "critical":
      return 0.95;
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

  getTaskExecutionStore(): TaskExecutionStore | null {
    return this.agentdb.getTaskExecutionStore();
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
  // =========================================================================

  async retrieve(options: RetrievalOptions): Promise<Result<RetrievalResult[], Error>> {
    try {
      if (options.mode === "chat") {
        return await this.retrieveFromChat(options.chatId, {
          limit: options.limit,
          minScore: options.minScore,
          query: options.query,
        });
      }

      const query = "query" in options ? options.query ?? "" : "";
      let results: RetrievalResult[];

      if (options.mode === "hybrid" && query.length > 0) {
        results = await this.agentdb.retrieveHybrid(query, {
          limit: this.expandLimit(options.limit),
          semanticWeight: options.semanticWeight,
        });
      } else if (options.mode === "type" || query.length === 0) {
        results = await this.agentdb.retrieve(query, options);
      } else {
        const embedding = "embedding" in options ? options.embedding : undefined;
        results = await this.agentdb.retrieveSemantic(query, {
          limit: this.expandLimit(options.limit),
          embedding,
        });
      }

      return ok(this.postProcessResults(results, options));
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // Analysis Cache — return type translation
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

  async invalidateAnalysis(projectPath: string): Promise<Result<void, Error>> {
    try {
      const internals = this.agentdb as unknown as AgentDBAdapterInternals;
      if (internals.cachedAnalysis?.projectPath === projectPath) {
        internals.cachedAnalysis = null;
      }
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // Conversation
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
      const result = await this.agentdb.storeEntry({
        type: "conversation",
        content: summary,
        tags: [...(options?.tags ?? []), "conversation"],
        importance: options?.importance ?? "medium",
        archived: false,
        metadata: {
          ...(options?.userMessage ? { userMessage: options.userMessage } : {}),
          ...(options?.assistantMessage ? { assistantMessage: options.assistantMessage } : {}),
          ...(options?.turnNumber !== undefined ? { turnNumber: options.turnNumber } : {}),
        },
        tier: MemoryTier.Working,
        importanceScore: createBrand(
          importanceToScore(options?.importance ?? "medium"),
          "NormalizedScore" as const,
        ),
        chatId,
      } as unknown as Parameters<typeof this.agentdb.storeEntry>[0]);

      if (result.kind === "err") {
        return err(result.error);
      }

      return ok(result.value.id);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async getChatHistory(
    chatId: ChatId,
    options?: { limit?: number; before?: TimestampMs },
  ): Promise<Result<ConversationMemoryEntry[], Error>> {
    try {
      const conversations = (await this.listAllEntries())
        .filter((entry): entry is ConversationMemoryEntry =>
          entry.type === "conversation" && entry.chatId === chatId,
        )
        .filter((entry) => !options?.before || entry.createdAt < options.before)
        .sort((a, b) => (b.createdAt as number) - (a.createdAt as number))
        .slice(0, options?.limit);

      return ok(conversations);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // General Memory Storage
  // =========================================================================

  async storeNote(
    content: string,
    options?: {
      title?: string;
      tags?: string[];
      importance?: MemoryImportance;
      source?: string;
      metadata?: MemoryMetadata;
    },
  ): Promise<Result<MemoryId, Error>> {
    try {
      const result = await this.agentdb.storeEntry({
        type: "note",
        content,
        tags: [...(options?.tags ?? []), "note"],
        importance: options?.importance ?? "medium",
        archived: false,
        metadata: {
          ...(options?.metadata ?? {}),
          ...(options?.title ? { title: options.title } : {}),
          ...(options?.source ? { source: options.source } : {}),
        },
        tier: MemoryTier.Persistent,
        importanceScore: createBrand(
          importanceToScore(options?.importance ?? "medium"),
          "NormalizedScore" as const,
        ),
        domain: options?.source,
      } as unknown as Parameters<typeof this.agentdb.storeEntry>[0]);

      if (result.kind === "err") {
        return err(result.error);
      }

      return ok(result.value.id);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async storeError(
    errorValue: Error,
    context: {
      category: string;
      location?: string;
      chatId?: ChatId;
    },
    options?: {
      tags?: string[];
      metadata?: MemoryMetadata;
    },
  ): Promise<Result<MemoryId, Error>> {
    try {
      const result = await this.agentdb.storeEntry({
        type: "error",
        content: errorValue.message,
        tags: [...(options?.tags ?? []), "error", context.category],
        importance: "high",
        archived: false,
        metadata: {
          ...(options?.metadata ?? {}),
          errorCategory: context.category,
          errorCode: errorValue.name,
          ...(context.location ? { location: context.location } : {}),
          ...(errorValue.stack ? { stack: errorValue.stack } : {}),
          resolved: false,
        },
        tier: MemoryTier.Persistent,
        importanceScore: createBrand(importanceToScore("high"), "NormalizedScore" as const),
        chatId: context.chatId,
        domain: "error-log",
      } as unknown as Parameters<typeof this.agentdb.storeEntry>[0]);

      if (result.kind === "err") {
        return err(result.error);
      }

      return ok(result.value.id);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async resolveError(id: MemoryId, resolution: string): Promise<Result<void, Error>> {
    try {
      const rawEntry = await this.getRawEntry(id);
      if (rawEntry.kind === "err") {
        return rawEntry;
      }
      if (rawEntry.value.kind === "none") {
        return err(new Error(`Error entry not found: ${id}`));
      }

      const entry = rawEntry.value.value;
      if (entry.type !== "error") {
        return err(new Error(`Entry is not an error: ${id}`));
      }

      const metadata = toMutableMetadata(entry.metadata);
      metadata["resolved"] = true;
      metadata["resolution"] = resolution;
      entry.metadata = metadata;
      entry.resolved = true;
      entry.resolution = resolution;
      this.persistMutableEntry(entry);

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async storeEntry<T extends MemoryEntry>(
    entry: Omit<T, "id" | "createdAt" | "accessCount">,
  ): Promise<Result<T, Error>> {
    try {
      const result = await this.agentdb.storeEntry(
        entry as unknown as Parameters<typeof this.agentdb.storeEntry>[0],
      );
      if (result.kind === "err") {
        return err(result.error);
      }
      return ok(this.normalizeEntry(result.value as MemoryEntry) as T);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async getEntry<T extends MemoryEntry>(id: MemoryId): Promise<Result<Option<T>, Error>> {
    try {
      const result = await this.agentdb.getById(id);
      if (result.kind !== "ok") {
        return err(result.error);
      }
      if (result.value.kind === "none") {
        return ok(none());
      }
      return ok(some(this.normalizeEntry(result.value.value as MemoryEntry) as T));
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async updateEntry<T extends MemoryEntry>(
    id: MemoryId,
    updates: Partial<Omit<T, "id" | "createdAt">>,
  ): Promise<Result<T, Error>> {
    try {
      if ("content" in updates && updates.content !== undefined) {
        return err(new Error("content updates are not supported in AgentDBAdapter"));
      }

      const rawEntry = await this.getRawEntry(id);
      if (rawEntry.kind === "err") {
        return rawEntry as Result<T, Error>;
      }
      if (rawEntry.value.kind === "none") {
        return err(new Error(`Entry not found: ${id}`));
      }

      const entry = rawEntry.value.value;
      const metadata = toMutableMetadata(entry.metadata);
      const typedUpdates = updates as Record<string, unknown>;

      if (typedUpdates["tags"] !== undefined && Array.isArray(typedUpdates["tags"])) {
        entry.tags = typedUpdates["tags"].map(String);
      }
      if (typedUpdates["importance"] !== undefined && isMemoryImportance(typedUpdates["importance"])) {
        entry.importance = typedUpdates["importance"];
        entry.importanceScore = importanceToScore(typedUpdates["importance"]);
      }
      if (typedUpdates["archived"] !== undefined) {
        entry.archived = Boolean(typedUpdates["archived"]);
      }
      if (typedUpdates["metadata"] !== undefined && isRecord(typedUpdates["metadata"])) {
        Object.assign(metadata, typedUpdates["metadata"]);
      }

      switch (entry.type) {
        case "conversation":
          if (typedUpdates["chatId"] !== undefined && typeof typedUpdates["chatId"] === "string") {
            entry.chatId = createBrand(typedUpdates["chatId"], "ChatId" as const);
          }
          if (typedUpdates["userMessage"] !== undefined && typeof typedUpdates["userMessage"] === "string") {
            entry.userMessage = typedUpdates["userMessage"];
            metadata["userMessage"] = typedUpdates["userMessage"];
          }
          if (typedUpdates["assistantMessage"] !== undefined) {
            entry.assistantMessage = readString(typedUpdates["assistantMessage"]);
            metadata["assistantMessage"] = entry.assistantMessage ?? null;
          }
          if (typedUpdates["turnNumber"] !== undefined) {
            const turnNumber = readNumber(typedUpdates["turnNumber"]);
            entry.turnNumber = turnNumber;
            metadata["turnNumber"] = turnNumber ?? null;
          }
          break;
        case "analysis":
          if (typedUpdates["projectPath"] !== undefined && typeof typedUpdates["projectPath"] === "string") {
            metadata["projectPath"] = typedUpdates["projectPath"];
            entry.projectPath = typedUpdates["projectPath"];
          }
          if (
            typedUpdates["category"] === "structure"
            || typedUpdates["category"] === "quality"
            || typedUpdates["category"] === "dependencies"
            || typedUpdates["category"] === "performance"
          ) {
            metadata["category"] = typedUpdates["category"];
            entry.category = typedUpdates["category"];
          }
          if (typedUpdates["version"] !== undefined && typeof typedUpdates["version"] === "string") {
            metadata["analysisVersion"] = typedUpdates["version"];
            entry.version = typedUpdates["version"];
          }
          break;
        case "note":
        case "insight":
          if (typedUpdates["title"] !== undefined) {
            entry.title = readString(typedUpdates["title"]);
            metadata["title"] = entry.title ?? null;
          }
          if (typedUpdates["source"] !== undefined) {
            const source = readString(typedUpdates["source"]);
            if (source !== undefined) {
              entry.source = source;
            }
            metadata["source"] = source ?? null;
          }
          break;
        case "error":
          if (typedUpdates["errorCategory"] !== undefined && typeof typedUpdates["errorCategory"] === "string") {
            entry.errorCategory = typedUpdates["errorCategory"];
            metadata["errorCategory"] = typedUpdates["errorCategory"];
          }
          if (typedUpdates["errorCode"] !== undefined) {
            entry.errorCode = readString(typedUpdates["errorCode"]);
            metadata["errorCode"] = entry.errorCode ?? null;
          }
          if (typedUpdates["location"] !== undefined) {
            entry.location = readString(typedUpdates["location"]);
            metadata["location"] = entry.location ?? null;
          }
          if (typedUpdates["resolved"] !== undefined) {
            entry.resolved = Boolean(typedUpdates["resolved"]);
            metadata["resolved"] = entry.resolved;
          }
          if (typedUpdates["resolution"] !== undefined) {
            entry.resolution = readString(typedUpdates["resolution"]);
            metadata["resolution"] = entry.resolution ?? null;
          }
          break;
        case "command":
          if (typedUpdates["command"] !== undefined) {
            const command = readString(typedUpdates["command"]);
            if (command !== undefined) {
              entry.command = command;
            }
            metadata["command"] = command ?? null;
          }
          if (typedUpdates["workingDirectory"] !== undefined) {
            const workingDirectory = readString(typedUpdates["workingDirectory"]);
            if (workingDirectory !== undefined) {
              entry.workingDirectory = workingDirectory;
            }
            metadata["workingDirectory"] = workingDirectory ?? null;
          }
          if (typedUpdates["exitCode"] !== undefined) {
            const exitCode = readNumber(typedUpdates["exitCode"]);
            if (exitCode !== undefined) {
              entry.exitCode = exitCode;
            }
            metadata["exitCode"] = exitCode ?? null;
          }
          if (typedUpdates["success"] !== undefined) {
            entry.success = Boolean(typedUpdates["success"]);
            metadata["success"] = entry.success;
          }
          break;
        case "task":
          if (typedUpdates["task"] !== undefined) {
            const task = readString(typedUpdates["task"]);
            if (task !== undefined) {
              entry.task = task;
            }
            metadata["task"] = task ?? null;
          }
          if (typedUpdates["status"] !== undefined && typeof typedUpdates["status"] === "string") {
            const status = typedUpdates["status"] as AdapterInternalEntry["status"];
            if (status !== undefined) {
              entry.status = status;
              metadata["status"] = status;
            }
          }
          if (typedUpdates["parentTaskId"] !== undefined && typeof typedUpdates["parentTaskId"] === "string") {
            entry.parentTaskId = createBrand(typedUpdates["parentTaskId"], "MemoryId" as const);
            metadata["parentTaskId"] = entry.parentTaskId;
          }
          if (typedUpdates["dueDate"] !== undefined) {
            const dueDate = readNumber(typedUpdates["dueDate"]);
            entry.dueDate = dueDate !== undefined
              ? createBrand(dueDate, "TimestampMs" as const)
              : undefined;
            metadata["dueDate"] = dueDate ?? null;
          }
          break;
      }

      entry.metadata = metadata;
      this.persistMutableEntry(entry);
      return ok(this.normalizeEntry(entry) as T);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async deleteEntry(id: MemoryId): Promise<Result<boolean, Error>> {
    return this.agentdb.delete(id);
  }

  // =========================================================================
  // Retrieval variants
  // =========================================================================

  async retrievePaginated(
    options: RetrievalOptions,
    pagination: { page: number; pageSize: number; cursor?: string },
  ): Promise<Result<PaginatedRetrievalResult, Error>> {
    try {
      const result = await this.retrieve(options);
      if (result.kind === "err") {
        return result;
      }

      const page = Math.max(pagination.page, 1);
      const pageSize = Math.max(pagination.pageSize, 1);
      const start = (page - 1) * pageSize;
      const end = start + pageSize;

      return ok({
        results: result.value.slice(start, end),
        totalCount: result.value.length,
        page,
        pageSize,
        hasMore: end < result.value.length,
        nextCursor: end < result.value.length ? String(page + 1) : undefined,
      });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async retrieveSemantic(
    query: string,
    options?: Omit<SemanticRetrievalOptions, "mode" | "query">,
  ): Promise<Result<RetrievalResult[], Error>> {
    try {
      const results = await this.agentdb.retrieveSemantic(query, {
        ...options,
        limit: this.expandLimit(options?.limit),
      });
      return ok(this.postProcessResults(results, { ...options }));
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async retrieveFromChat(
    chatId: ChatId,
    options?: Omit<ChatRetrievalOptions, "mode" | "chatId">,
  ): Promise<Result<RetrievalResult<ConversationMemoryEntry>[], Error>> {
    try {
      if (!options?.query) {
        const results = (await this.listAllEntries())
          .filter((entry): entry is ConversationMemoryEntry =>
            entry.type === "conversation" && entry.chatId === chatId,
          )
          .sort((a, b) => (b.createdAt as number) - (a.createdAt as number))
          .slice(0, options?.limit)
          .map((entry) => ({
            entry,
            score: createBrand(1, "NormalizedScore" as const),
          }));
        return ok(results);
      }

      const results = await this.agentdb.retrieve(options.query, {
        mode: "chat",
        chatId,
        limit: this.expandLimit(options.limit),
        query: options.query,
      });

      const filtered = this.postProcessResults(results, {
        limit: options.limit,
        minScore: options.minScore,
      }).filter(
        (result): result is RetrievalResult<ConversationMemoryEntry> =>
          result.entry.type === "conversation" && result.entry.chatId === chatId,
      );

      return ok(filtered.slice(0, options.limit ?? filtered.length));
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // Management
  // =========================================================================

  async archiveOldEntries(before: TimestampMs): Promise<Result<number, Error>> {
    try {
      let archived = 0;
      for (const entry of await this.listRawEntries()) {
        if ((entry.createdAt as number) < (before as number) && !entry.archived) {
          entry.archived = true;
          this.persistMutableEntry(entry);
          archived++;
        }
      }
      return ok(archived);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async compact(): Promise<Result<{ freedBytes: number }, Error>> {
    try {
      return ok(await this.agentdb.compact());
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // Stats & Health
  // =========================================================================

  getStats(): MemoryStats {
    return this.agentdb.getStats();
  }

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
  // Export/Import
  // =========================================================================

  async export(
    options?: {
      types?: MemoryEntryType[];
      after?: TimestampMs;
      before?: TimestampMs;
    },
  ): Promise<Result<JsonObject, Error>> {
    try {
      let entries = await this.listAllEntries();

      if (options?.types) {
        entries = entries.filter((entry) => options.types!.includes(entry.type));
      }
      if (options?.after) {
        entries = entries.filter((entry) => (entry.createdAt as number) >= (options.after as number));
      }
      if (options?.before) {
        entries = entries.filter((entry) => (entry.createdAt as number) <= (options.before as number));
      }

      return ok({
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: entries.map((entry) => this.serializeEntry(entry)),
      } as unknown as JsonObject);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async import(data: JsonObject): Promise<Result<number, Error>> {
    try {
      if (!isRecord(data) || !Array.isArray(data["entries"])) {
        return err(new Error("Invalid import data format"));
      }

      let imported = 0;
      for (const raw of data["entries"]) {
        if (!isRecord(raw)) {
          continue;
        }

        const type = raw["type"];
        const content = raw["content"];
        if (!isMemoryEntryType(type) || typeof content !== "string") {
          continue;
        }

        const metadata = this.buildImportedMetadata(raw);
        const result = await this.agentdb.storeEntry({
          type,
          content,
          tags: Array.isArray(raw["tags"]) ? raw["tags"].map(String) : [],
          importance: isMemoryImportance(raw["importance"]) ? raw["importance"] : "medium",
          archived: Boolean(raw["archived"]),
          metadata,
          tier: this.inferImportTier(type),
          importanceScore: createBrand(
            importanceToScore(
              isMemoryImportance(raw["importance"]) ? raw["importance"] : "medium",
            ),
            "NormalizedScore" as const,
          ),
          chatId: typeof raw["chatId"] === "string"
            ? createBrand(raw["chatId"], "ChatId" as const)
            : undefined,
          domain: readString(raw["projectPath"]) ?? readString(raw["source"]) ?? undefined,
        } as unknown as Parameters<typeof this.agentdb.storeEntry>[0]);

        if (result.kind === "ok") {
          imported++;
        }
      }

      return ok(imported);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async listAllEntries(): Promise<MemoryEntry[]> {
    const rawEntries = await this.listRawEntries();
    return rawEntries.map((entry) => this.normalizeEntry(entry));
  }

  private async listRawEntries(): Promise<AdapterInternalEntry[]> {
    const byTier = await Promise.all(MEMORY_TIERS.map((tier) => this.agentdb.getByTier(tier)));
    const seen = new Set<string>();
    const entries: AdapterInternalEntry[] = [];

    for (const group of byTier) {
      for (const entry of group) {
        const rawEntry = this.asMutableEntry(entry);
        const key = String(rawEntry.id);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push(rawEntry);
      }
    }

    return entries;
  }

  private async getRawEntry(id: MemoryId): Promise<Result<Option<AdapterInternalEntry>, Error>> {
    const result = await this.agentdb.getById(id);
    if (result.kind === "err") {
      return err(result.error);
    }
    if (result.value.kind === "none") {
      return ok(none());
    }
    return ok(some(this.asMutableEntry(result.value.value)));
  }

  private asMutableEntry(entry: MemoryEntry): AdapterInternalEntry {
    return entry as unknown as AdapterInternalEntry;
  }

  private persistMutableEntry(entry: AdapterInternalEntry): void {
    const internals = this.agentdb as unknown as AgentDBAdapterInternals;
    internals.persistEntry(entry);
  }

  private expandLimit(limit: number | undefined): number | undefined {
    return limit !== undefined ? Math.max(limit * 2, limit) : limit;
  }

  private normalizeEntry(entry: MemoryEntry): MemoryEntry {
    const rawEntry = this.asMutableEntry(entry);
    const metadata = toMutableMetadata(rawEntry.metadata);
    const rawChatId = readString((rawEntry as Record<string, unknown>)["chatId"]);

    switch (rawEntry.type) {
      case "conversation":
        return {
          ...rawEntry,
          type: "conversation",
          chatId: rawChatId
            ? createBrand(rawChatId, "ChatId" as const)
            : createBrand("default", "ChatId" as const),
          userMessage: rawEntry.userMessage
            ?? readString(metadata["userMessage"])
            ?? rawEntry.content,
          assistantMessage: rawEntry.assistantMessage ?? readString(metadata["assistantMessage"]),
          turnNumber: rawEntry.turnNumber ?? readNumber(metadata["turnNumber"]),
        };
      case "analysis":
        return {
          ...rawEntry,
          type: "analysis",
          projectPath: rawEntry.projectPath
            ?? readString(metadata["projectPath"])
            ?? rawEntry.domain
            ?? "unknown",
          category: (rawEntry.category
            ?? readString(metadata["category"])
            ?? "structure") as "structure" | "quality" | "dependencies" | "performance",
          version: rawEntry.version
            ?? rawEntry.analysisVersion
            ?? readString(metadata["analysisVersion"])
            ?? "1.0",
        };
      case "note":
      case "insight":
        return {
          ...rawEntry,
          type: rawEntry.type,
          title: rawEntry.title ?? readString(metadata["title"]),
          source: rawEntry.source ?? readString(metadata["source"]) ?? "user",
        };
      case "error":
        return {
          ...rawEntry,
          type: "error",
          errorCategory: rawEntry.errorCategory ?? readString(metadata["errorCategory"]) ?? "general",
          errorCode: rawEntry.errorCode ?? readString(metadata["errorCode"]),
          location: rawEntry.location ?? readString(metadata["location"]),
          resolved: rawEntry.resolved ?? readBoolean(metadata["resolved"]) ?? false,
          resolution: rawEntry.resolution ?? readString(metadata["resolution"]),
        };
      case "command":
        return {
          ...rawEntry,
          type: "command",
          command: rawEntry.command ?? readString(metadata["command"]) ?? rawEntry.content,
          workingDirectory: rawEntry.workingDirectory ?? readString(metadata["workingDirectory"]) ?? ".",
          exitCode: rawEntry.exitCode ?? readNumber(metadata["exitCode"]) ?? 0,
          success: rawEntry.success ?? readBoolean(metadata["success"]) ?? true,
        };
      case "task":
        return {
          ...rawEntry,
          type: "task",
          task: rawEntry.task ?? readString(metadata["task"]) ?? rawEntry.content,
          status: rawEntry.status
            ?? (readString(metadata["status"]) as AdapterInternalEntry["status"])
            ?? "pending",
          parentTaskId: rawEntry.parentTaskId
            ?? (readString(metadata["parentTaskId"])
              ? createBrand(String(metadata["parentTaskId"]), "MemoryId" as const)
              : undefined),
          dueDate: rawEntry.dueDate
            ?? (readNumber(metadata["dueDate"]) !== undefined
              ? createBrand(readNumber(metadata["dueDate"])!, "TimestampMs" as const)
              : undefined),
        };
    }
  }

  private postProcessResults(
    results: RetrievalResult[],
    options: Pick<
      RetrievalOptions,
      "limit" | "minScore" | "sortBy" | "tags" | "importance" | "includeArchived" | "after" | "before"
    >,
  ): RetrievalResult[] {
    const normalized = results
      .map((result) => ({
        ...result,
        entry: this.normalizeEntry(result.entry),
      }))
      .filter((result) => this.matchesFilters(result.entry, result.score, options));

    const sorted = normalized.sort((a, b) => {
      switch (options.sortBy) {
        case "newest":
          return (b.entry.createdAt as number) - (a.entry.createdAt as number);
        case "oldest":
          return (a.entry.createdAt as number) - (b.entry.createdAt as number);
        case "most_accessed":
          return b.entry.accessCount - a.entry.accessCount;
        case "relevance":
        default:
          return (b.score as number) - (a.score as number);
      }
    });

    return sorted.slice(0, options.limit ?? sorted.length);
  }

  private matchesFilters(
    entry: MemoryEntry,
    score: number,
    options: Pick<
      RetrievalOptions,
      "minScore" | "tags" | "importance" | "includeArchived" | "after" | "before"
    >,
  ): boolean {
    if (options.minScore !== undefined && score < options.minScore) {
      return false;
    }
    if (options.tags && !options.tags.every((tag) => entry.tags.includes(tag))) {
      return false;
    }
    if (options.importance && !options.importance.includes(entry.importance)) {
      return false;
    }
    if (options.includeArchived === false && entry.archived) {
      return false;
    }
    if (options.after && (entry.createdAt as number) < (options.after as number)) {
      return false;
    }
    if (options.before && (entry.createdAt as number) > (options.before as number)) {
      return false;
    }
    return true;
  }

  private inferImportTier(type: MemoryEntryType): MemoryTier {
    switch (type) {
      case "conversation":
      case "command":
      case "task":
        return MemoryTier.Working;
      case "analysis":
      case "note":
      case "insight":
      case "error":
        return MemoryTier.Persistent;
    }
  }

  private buildImportedMetadata(raw: Record<string, unknown>): MemoryMetadata {
    const metadata = isRecord(raw["metadata"]) ? { ...raw["metadata"] } : {};

    if (typeof raw["id"] === "string") {
      metadata["originalId"] = raw["id"];
    }
    if (readNumber(raw["createdAt"]) !== undefined) {
      metadata["originalCreatedAt"] = readNumber(raw["createdAt"]);
    }

    for (const key of [
      "userMessage",
      "assistantMessage",
      "turnNumber",
      "projectPath",
      "category",
      "version",
      "title",
      "source",
      "errorCategory",
      "errorCode",
      "location",
      "resolved",
      "resolution",
      "command",
      "workingDirectory",
      "exitCode",
      "success",
      "task",
      "status",
      "parentTaskId",
      "dueDate",
      "chatId",
    ] as const) {
      if (raw[key] !== undefined) {
        metadata[key === "version" ? "analysisVersion" : key] = raw[key] as
          | JsonObject
          | string
          | number
          | boolean
          | null;
      }
    }

    return metadata as MemoryMetadata;
  }

  private serializeEntry(entry: MemoryEntry): Record<string, unknown> {
    const base = {
      id: entry.id as string,
      type: entry.type,
      content: entry.content,
      createdAt: entry.createdAt as number,
      lastAccessedAt: entry.lastAccessedAt as number | undefined,
      tags: entry.tags,
      importance: entry.importance,
      accessCount: entry.accessCount,
      archived: entry.archived,
      metadata: entry.metadata as unknown as Record<string, unknown>,
    };

    switch (entry.type) {
      case "conversation":
        return {
          ...base,
          chatId: entry.chatId as string,
          userMessage: entry.userMessage,
          assistantMessage: entry.assistantMessage,
          turnNumber: entry.turnNumber,
        };
      case "analysis":
        return {
          ...base,
          projectPath: entry.projectPath,
          category: entry.category,
          version: entry.version,
        };
      case "note":
      case "insight":
        return {
          ...base,
          title: entry.title,
          source: entry.source,
        };
      case "error":
        return {
          ...base,
          errorCategory: entry.errorCategory,
          errorCode: entry.errorCode,
          location: entry.location,
          resolved: entry.resolved,
          resolution: entry.resolution,
        };
      case "command":
        return {
          ...base,
          command: entry.command,
          workingDirectory: entry.workingDirectory,
          exitCode: entry.exitCode,
          success: entry.success,
        };
      case "task":
        return {
          ...base,
          task: entry.task,
          status: entry.status,
          parentTaskId: entry.parentTaskId as string | undefined,
          dueDate: entry.dueDate as number | undefined,
        };
    }
  }
}
