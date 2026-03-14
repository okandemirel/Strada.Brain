import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  IMemoryManager,
  MemoryEntry,
  RetrievalOptions,
  RetrievalResult,
  ConversationMemoryEntry,
  MemoryImportance,
  MemoryMetadata,
} from "./memory.interface.js";
import type { StradaProjectAnalysis } from "../intelligence/strada-analyzer.js";
import {
  extractTerms,
  cosineSimilarity,
} from "./text-index.js";
import { getLogger } from "../utils/logger.js";
import type { 
  Result, 
  Option, 
  MemoryId, 
  ChatId, 
  TimestampMs, 
  DurationMs,
  JsonObject
} from "../types/index.js";
import {
  ok,
  err,
  some,
  none,
  createBrand,
} from "../types/index.js";

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MIN_SCORE = 0.1;
const DEFAULT_LIMIT = 5;
const DEFAULT_ANALYSIS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const FLUSH_DEBOUNCE_MS = 5000;
const MAX_FLUSH_WAIT_MS = 30000; // Maximum time to wait before forced flush

import { LRUCache } from "../common/lru-cache.js";

/**
 * Optimized TF-IDF computation with caching
 */
// Note: OptimizedTextIndex provides optimized TF-IDF computation with caching
class OptimizedTextIndex {
  // Note: This class provides optimized caching for TF-IDF computation
  private tfCache: LRUCache<string, Map<string, number>> = new LRUCache(1000);
  private idfCache: Map<string, number> = new Map();
  private docFrequency: Map<string, number> = new Map();
  private docCount: number = 0;

  /**
   * Optimized TF computation with memoization
   */
  computeTFOptimized(terms: string[]): Map<string, number> {
    const cacheKey = terms.join('\x00');
    const cached = this.tfCache.get(cacheKey);
    if (cached) return cached;

    const tf = new Map<string, number>();
    const len = terms.length;
    
    // Single pass frequency count
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }
    
    // Normalize
    for (const [term, count] of tf) {
      tf.set(term, count / len);
    }

    this.tfCache.set(cacheKey, tf);
    return tf;
  }

  /**
   * Optimized IDF with caching
   */
  computeIDFOptimized(term: string): number {
    const cached = this.idfCache.get(term);
    if (cached !== undefined) return cached;

    const df = this.docFrequency.get(term) || 0;
    const idf = Math.log((this.docCount + 1) / (df + 1)) + 1;
    
    this.idfCache.set(term, idf);
    return idf;
  }

  /**
   * Optimized TF-IDF computation
   */
  computeTFIDFOptimized(terms: string[]): Record<string, number> {
    const tf = this.computeTFOptimized(terms);
    const tfidf: Record<string, number> = {};
    
    for (const [term, tfValue] of tf) {
      tfidf[term] = tfValue * this.computeIDFOptimized(term);
    }
    
    return tfidf;
  }

  /**
   * Add a single document
   */
  addDocument(terms: string[]): void {
    this.docCount++;
    const seen = new Set<string>();
    for (const term of terms) {
      if (!seen.has(term)) {
        seen.add(term);
        this.docFrequency.set(term, (this.docFrequency.get(term) || 0) + 1);
      }
    }
    // Invalidate IDF cache
    this.idfCache.clear();
  }

  /**
   * Batch add documents for better performance
   */
  addDocuments(docs: string[][]): void {
    for (const terms of docs) {
      this.addDocument(terms);
    }
  }

  /**
   * Remove document
   */
  removeDocument(terms: string[]): void {
    this.docCount = Math.max(0, this.docCount - 1);
    const seen = new Set<string>();
    for (const term of terms) {
      if (!seen.has(term)) {
        seen.add(term);
        const count = this.docFrequency.get(term);
        if (count !== undefined) {
          if (count <= 1) {
            this.docFrequency.delete(term);
          } else {
            this.docFrequency.set(term, count - 1);
          }
        }
      }
    }
    // Invalidate IDF cache
    this.idfCache.clear();
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.tfCache.clear();
    this.idfCache.clear();
  }

  /**
   * Serialize for persistence
   */
  serialize(): { df: Record<string, number>; docCount: number } {
    const df: Record<string, number> = {};
    for (const [term, count] of this.docFrequency) {
      df[term] = count;
    }
    return { df, docCount: this.docCount };
  }
}

/** Persisted data structure for the memory store */
interface PersistedMemory {
  version: 1;
  entries: Array<{
    id: string;
    type: MemoryEntry["type"];
    chatId?: string;
    content: string;
    createdAt: string;
    tags: string[];
    importance?: MemoryImportance;
    accessCount?: number;
    lastAccessedAt?: string;
    archived?: boolean;
  }>;
  index: { df: Record<string, number>; docCount: number };
}

/** Persisted analysis cache */
interface PersistedAnalysis {
  projectPath: string;
  analysis: StradaProjectAnalysis & { analyzedAt: string };
}

/** Get current timestamp as TimestampMs */
function getNow(): TimestampMs {
  return createBrand(Date.now(), "TimestampMs" as const);
}

/**
 * File-based memory manager using JSON storage and optimized TF-IDF retrieval.
 *
 * Storage layout:
 *   <dbPath>/
 *     memory.json      — entries + TF-IDF index
 *     analysis.json    — cached project analysis
 */
export class FileMemoryManager implements IMemoryManager {
  private readonly dbPath: string;
  private readonly maxEntries: number;
  private entries: MemoryEntry[] = [];
  private index = new OptimizedTextIndex();
  private cachedAnalysis: { projectPath: string; analysis: StradaProjectAnalysis } | null = null;
  
  // Debounced flush with max wait time
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private pendingFlush: boolean = false;
  
  // LRU cache for recent entries (access-based eviction)
  private entryAccessCache: LRUCache<string, number> = new LRUCache(100);

  constructor(dbPath: string, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.dbPath = dbPath;
    this.maxEntries = maxEntries;
  }

  async initialize(): Promise<Result<void, Error>> {
    try {
      await mkdir(this.dbPath, { recursive: true });

      // Load memory entries
      try {
        const raw = await readFile(join(this.dbPath, "memory.json"), "utf-8");
        const data = JSON.parse(raw) as PersistedMemory;

        if (data.version === 1) {
          this.entries = data.entries.map((e) => {
            const baseEntry = {
              id: createBrand(e.id, "MemoryId" as const),
              type: e.type,
              content: e.content,
              createdAt: createBrand(new Date(e.createdAt).getTime(), "TimestampMs" as const),
              tags: e.tags,
              importance: e.importance ?? "medium",
              accessCount: e.accessCount ?? 0,
              lastAccessedAt: e.lastAccessedAt ? createBrand(new Date(e.lastAccessedAt).getTime(), "TimestampMs" as const) : undefined,
              archived: e.archived ?? false,
              metadata: {},
            };
            
            // Add type-specific fields
            if (e.type === "conversation") {
              return {
                ...baseEntry,
                type: "conversation" as const,
                chatId: e.chatId ? createBrand(e.chatId, "ChatId" as const) : (createBrand("default", "ChatId" as const)),
                userMessage: e.content,
              } as ConversationMemoryEntry;
            } else if (e.type === "analysis") {
              return {
                ...baseEntry,
                type: "analysis" as const,
                projectPath: "unknown",
                category: "structure" as const,
                version: "1.0",
              } as import("./memory.interface.js").AnalysisMemoryEntry;
            } else if (e.type === "note" || e.type === "insight") {
              return {
                ...baseEntry,
                type: e.type,
                source: "user",
              } as import("./memory.interface.js").NoteMemoryEntry;
            } else if (e.type === "error") {
              return {
                ...baseEntry,
                type: "error" as const,
                errorCategory: "general",
                resolved: false,
              } as import("./memory.interface.js").ErrorMemoryEntry;
            } else if (e.type === "command") {
              return {
                ...baseEntry,
                type: "command" as const,
                command: e.content,
                workingDirectory: ".",
                exitCode: 0,
                success: true,
              } as import("./memory.interface.js").CommandMemoryEntry;
            } else if (e.type === "task") {
              return {
                ...baseEntry,
                type: "task" as const,
                task: e.content,
                status: "pending" as const,
              } as import("./memory.interface.js").TaskMemoryEntry;
            }
            
            return baseEntry as unknown as MemoryEntry;
          });

          // Rebuild index
          this.index = new OptimizedTextIndex();
          for (const entry of this.entries) {
            const terms = extractTerms(entry.content);
            this.index.addDocument(terms);
          }
        }
      } catch {
        // No existing memory — start fresh
      }

      // Load analysis cache
      try {
        const raw = await readFile(join(this.dbPath, "analysis.json"), "utf-8");
        const data = JSON.parse(raw) as PersistedAnalysis;
        this.cachedAnalysis = {
          projectPath: data.projectPath,
          analysis: {
            ...data.analysis,
            analyzedAt: new Date(data.analysis.analyzedAt),
          },
        };
      } catch {
        // No cached analysis
      }

      const logger = getLogger();
      logger.info("Memory manager initialized", {
        entries: this.entries.length,
        hasAnalysis: this.cachedAnalysis !== null,
      });

      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async shutdown(): Promise<Result<void, Error>> {
    try {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      if (this.flushDeadlineTimer) {
        clearTimeout(this.flushDeadlineTimer);
        this.flushDeadlineTimer = null;
      }
      if (this.dirty) {
        await this.flush();
      }
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // --- Project Analysis Cache ---

  async cacheAnalysis(
    analysis: StradaProjectAnalysis,
    projectPath: string,
    _options?: { ttl?: DurationMs }
  ): Promise<Result<void, Error>> {
    try {
      this.cachedAnalysis = { projectPath, analysis };

      const persisted: PersistedAnalysis = {
        projectPath,
        analysis: {
          ...analysis,
          analyzedAt: analysis.analyzedAt.toISOString(),
        } as unknown as StradaProjectAnalysis & { analyzedAt: string },
      };

      await writeFile(
        join(this.dbPath, "analysis.json"),
        JSON.stringify(persisted, null, 2),
        "utf-8"
      );

      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getCachedAnalysis(
    projectPath: string,
    maxAgeMs: number = DEFAULT_ANALYSIS_MAX_AGE_MS
  ): Promise<Result<Option<StradaProjectAnalysis>, Error>> {
    try {
      if (!this.cachedAnalysis) return ok(none());
      if (this.cachedAnalysis.projectPath !== projectPath) return ok(none());

      const age = Date.now() - this.cachedAnalysis.analysis.analyzedAt.getTime();
      if (age > maxAgeMs) return ok(none());

      return ok(some(this.cachedAnalysis.analysis));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async invalidateAnalysis(projectPath: string): Promise<Result<void, Error>> {
    try {
      if (this.cachedAnalysis?.projectPath === projectPath) {
        this.cachedAnalysis = null;
      }
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // --- Conversation Memory ---

  async storeConversation(
    chatId: ChatId,
    summary: string,
    options?: {
      tags?: string[];
      importance?: MemoryImportance;
      turnNumber?: number;
      userMessage?: string;
      assistantMessage?: string;
    }
  ): Promise<Result<MemoryId, Error>> {
    try {
      const id = createBrand(randomUUID(), "MemoryId" as const);
      
      // Create mutable entry first
      const mutableEntry = {
        id,
        type: "conversation" as const,
        chatId,
        content: summary,
        userMessage: options?.userMessage ?? summary,
        assistantMessage: options?.assistantMessage,
        turnNumber: options?.turnNumber,
        createdAt: getNow(),
        tags: options?.tags ?? [],
        importance: options?.importance ?? "medium",
        accessCount: 0,
        archived: false,
        metadata: {},
      };

      const terms = extractTerms(mutableEntry.content);
      this.index.addDocument(terms);

      this.entries.push(mutableEntry as unknown as ConversationMemoryEntry);
      this.entryAccessCache.set(mutableEntry.id as string, Date.now());

      this.evictIfNeeded();
      this.scheduleDirtyFlush();

      return ok(id);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getChatHistory(
    chatId: ChatId,
    options?: { limit?: number; before?: TimestampMs }
  ): Promise<Result<ConversationMemoryEntry[], Error>> {
    try {
      const limit = options?.limit ?? 10;
      const before = options?.before;

      const result: ConversationMemoryEntry[] = [];
      for (let i = this.entries.length - 1; i >= 0 && result.length < limit; i--) {
        const entry = this.entries[i];
        if (entry?.type === "conversation" && "chatId" in entry && entry.chatId === chatId) {
          if (before && entry.createdAt >= before) continue;
          result.unshift(entry as ConversationMemoryEntry);
        }
      }
      return ok(result);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // --- General Memory Storage ---

  async storeNote(
    content: string,
    options?: {
      title?: string;
      tags?: string[];
      importance?: MemoryImportance;
      source?: string;
      metadata?: MemoryMetadata;
    }
  ): Promise<Result<MemoryId, Error>> {
    try {
      const id = createBrand(randomUUID(), "MemoryId" as const);
      
      const mutableEntry = {
        id,
        type: "note" as const,
        content,
        createdAt: getNow(),
        tags: options?.tags ?? [],
        importance: options?.importance ?? "low",
        accessCount: 0,
        archived: false,
        metadata: options?.metadata ?? {},
      };

      const terms = extractTerms(mutableEntry.content);
      this.index.addDocument(terms);

      this.entries.push(mutableEntry as unknown as MemoryEntry);
      this.entryAccessCache.set(mutableEntry.id as string, Date.now());

      this.evictIfNeeded();
      this.scheduleDirtyFlush();

      return ok(id);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async storeError(
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
  ): Promise<Result<MemoryId, Error>> {
    try {
      const id = createBrand(randomUUID(), "MemoryId" as const);
      
      const mutableEntry = {
        id,
        type: "error" as const,
        content: error.message,
        createdAt: getNow(),
        tags: [...(options?.tags ?? []), "error", context.category],
        importance: "high" as const,
        accessCount: 0,
        archived: false,
        metadata: {
          ...options?.metadata,
          errorCategory: context.category,
          errorCode: error.name,
          location: context.location,
          resolved: false,
        },
      };

      const terms = extractTerms(mutableEntry.content);
      this.index.addDocument(terms);

      this.entries.push(mutableEntry as unknown as import("./memory.interface.js").ErrorMemoryEntry);
      this.entryAccessCache.set(mutableEntry.id as string, Date.now());

      this.evictIfNeeded();
      this.scheduleDirtyFlush();

      return ok(id);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async resolveError(
    id: MemoryId,
    resolution: string
  ): Promise<Result<void, Error>> {
    try {
      const entry = this.entries.find(e => e.id === id && e.type === "error");
      if (!entry) {
        return err(new Error(`Error entry not found: ${id}`));
      }
      
      // Update metadata - cast to mutable type
      const mutableEntry = entry as unknown as { metadata: Record<string, unknown> };
      mutableEntry.metadata.resolved = true;
      mutableEntry.metadata.resolution = resolution;
      
      this.scheduleDirtyFlush();
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async storeEntry<T extends MemoryEntry>(
    entry: Omit<T, "id" | "createdAt" | "accessCount">
  ): Promise<Result<T, Error>> {
    try {
      const id = createBrand(randomUUID(), "MemoryId" as const);
      const newEntry = {
        ...entry,
        id,
        createdAt: getNow(),
        accessCount: 0,
      } as T;

      const terms = extractTerms(newEntry.content);
      this.index.addDocument(terms);

      this.entries.push(newEntry);
      this.entryAccessCache.set(newEntry.id as string, Date.now());

      this.evictIfNeeded();
      this.scheduleDirtyFlush();

      return ok(newEntry);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getEntry<T extends MemoryEntry>(id: MemoryId): Promise<Result<Option<T>, Error>> {
    try {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) return ok(none());
      
      // Update access stats - cast to mutable
      const mutableEntry = entry as unknown as { accessCount: number; lastAccessedAt?: TimestampMs };
      mutableEntry.accessCount++;
      mutableEntry.lastAccessedAt = getNow();
      this.entryAccessCache.set(entry.id as string, Date.now());
      
      return ok(some(entry as T));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async updateEntry<T extends MemoryEntry>(
    id: MemoryId,
    updates: Partial<Omit<T, "id" | "createdAt">>
  ): Promise<Result<T, Error>> {
    try {
      const index = this.entries.findIndex(e => e.id === id);
      if (index === -1) {
        return err(new Error(`Entry not found: ${id}`));
      }
      
      this.entries[index] = { ...this.entries[index], ...updates } as T;
      this.scheduleDirtyFlush();
      
      return ok(this.entries[index] as T);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async deleteEntry(id: MemoryId): Promise<Result<boolean, Error>> {
    try {
      const index = this.entries.findIndex(e => e.id === id);
      if (index === -1) return ok(false);
      
      const removed = this.entries.splice(index, 1)[0];
      if (removed) {
        const terms = extractTerms(removed.content);
        this.index.removeDocument(terms);
        this.entryAccessCache.delete(removed.id as string);
      }
      
      this.scheduleDirtyFlush();
      return ok(true);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // --- Retrieval ---

  async retrieve(
    options: RetrievalOptions
  ): Promise<Result<RetrievalResult[], Error>> {
    try {
      const limit = options.limit ?? DEFAULT_LIMIT;
      const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

      // Get query from options based on mode
      let queryText = "";
      if (options.mode === "text" || options.mode === "semantic" || options.mode === "hybrid") {
        queryText = options.query;
      } else if (options.mode === "chat" && options.query) {
        queryText = options.query;
      }

      // Compute query vector
      const queryTerms = extractTerms(queryText);
      if (queryTerms.length === 0) return ok([]);

      const queryVector = this.index.computeTFIDFOptimized(queryTerms);

      // Pre-allocate result array with estimated size
      const scored: RetrievalResult[] = [];

      // Use for loop for better performance than forEach
      for (let i = 0; i < this.entries.length; i++) {
        const entry = this.entries[i]!;
        
        // Apply filters based on RetrievalOptions mode
        if (options.mode === "chat" && "chatId" in entry && entry.chatId !== options.chatId) continue;
        if (options.mode === "type" && !options.types?.includes(entry.type)) continue;
        if (options.tags && !options.tags.every(tag => entry.tags.includes(tag))) continue;
        if (options.importance && !options.importance.includes(entry.importance)) continue;
        if (options.includeArchived === false && entry.archived) continue;
        if (options.after && entry.createdAt < options.after) continue;
        if (options.before && entry.createdAt > options.before) continue;

        // Compute TF-IDF similarity
        const entryTerms = extractTerms(entry.content);
        const entryVector = this.index.computeTFIDFOptimized(entryTerms);
        const score = cosineSimilarity(queryVector, entryVector);

        if (score >= minScore) {
          scored.push({ entry, score });
          
          // Track access for LRU
          this.entryAccessCache.set(entry.id as string, Date.now());
        }
      }

      // Sort and limit
      scored.sort((a, b) => b.score - a.score);
      const results = scored.slice(0, limit);
      
      return ok(results);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async retrievePaginated(
    options: RetrievalOptions,
    pagination: { page: number; pageSize: number; cursor?: string }
  ): Promise<Result<import("./memory.interface.js").PaginatedRetrievalResult, Error>> {
    try {
      const result = await this.retrieve(options);
      if (result.kind === "err") return result;
      
      const allResults = result.value;
      const { page, pageSize } = pagination;
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const pageResults = allResults.slice(start, end);
      
      return ok({
        results: pageResults,
        totalCount: allResults.length,
        page,
        pageSize,
        hasMore: end < allResults.length,
        nextCursor: end < allResults.length ? String(page + 1) : undefined,
      });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async retrieveSemantic(
    query: string,
    options?: Omit<import("./memory.interface.js").SemanticRetrievalOptions, "mode" | "query">
  ): Promise<Result<RetrievalResult[], Error>> {
    // For file-based memory without embeddings, fall back to text search
    return this.retrieve({ mode: "text", query, ...options });
  }

  async retrieveFromChat(
    chatId: ChatId,
    options?: Omit<import("./memory.interface.js").ChatRetrievalOptions, "mode" | "chatId">
  ): Promise<Result<RetrievalResult<ConversationMemoryEntry>[], Error>> {
    try {
      const limit = options?.limit ?? DEFAULT_LIMIT;
      const query = options?.query;
      
      const chatEntries = this.entries.filter(
        (e): e is ConversationMemoryEntry => 
          e.type === "conversation" && "chatId" in e && e.chatId === chatId
      );
      
      if (!query) {
        // Return most recent entries
        const sorted = chatEntries
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit);
        return ok(sorted.map(entry => ({ entry, score: 1.0 })));
      }
      
      // Use text search
      const queryTerms = extractTerms(query);
      if (queryTerms.length === 0) return ok([]);
      
      const queryVector = this.index.computeTFIDFOptimized(queryTerms);
      const scored: RetrievalResult<ConversationMemoryEntry>[] = [];
      
      for (const entry of chatEntries) {
        const entryTerms = extractTerms(entry.content);
        const entryVector = this.index.computeTFIDFOptimized(entryTerms);
        const score = cosineSimilarity(queryVector, entryVector);
        
        if (score >= (options?.minScore ?? DEFAULT_MIN_SCORE)) {
          scored.push({ entry, score });
        }
      }
      
      scored.sort((a, b) => b.score - a.score);
      return ok(scored.slice(0, limit));
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // --- Management ---

  async archiveOldEntries(before: TimestampMs): Promise<Result<number, Error>> {
    try {
      let archived = 0;
      for (const entry of this.entries) {
        if (entry.createdAt < before && !entry.archived) {
          // Cast to mutable to update archived flag
          (entry as unknown as { archived: boolean }).archived = true;
          archived++;
        }
      }
      if (archived > 0) {
        this.scheduleDirtyFlush();
      }
      return ok(archived);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async compact(): Promise<Result<{ freedBytes: number }, Error>> {
    try {
      const beforeSize = JSON.stringify(this.entries).length;
      
      // Remove archived entries older than 30 days
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      this.entries = this.entries.filter(e => !e.archived || e.createdAt > cutoff);
      
      const afterSize = JSON.stringify(this.entries).length;
      const freedBytes = Math.max(0, beforeSize - afterSize);
      
      await this.flush();
      
      return ok({ freedBytes });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getStats(): import("./memory.interface.js").MemoryStats {
    let conversationCount = 0;
    let noteCount = 0;
    let errorCount = 0;
    let archivedCount = 0;
    const entriesByType: Record<string, number> = {};
    const entriesByImportance: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    
    for (const entry of this.entries) {
      entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;
      entriesByImportance[entry.importance] = (entriesByImportance[entry.importance] || 0) + 1;
      
      if (entry.type === "conversation") conversationCount++;
      else if (entry.type === "note") noteCount++;
      else if (entry.type === "error") errorCount++;
      
      if (entry.archived) archivedCount++;
    }
    
    return {
      totalEntries: this.entries.length,
      entriesByType: entriesByType as import("./memory.interface.js").MemoryStats["entriesByType"],
      entriesByImportance: entriesByImportance as import("./memory.interface.js").MemoryStats["entriesByImportance"],
      conversationCount,
      noteCount,
      errorCount,
      archivedCount,
      hasAnalysisCache: this.cachedAnalysis !== null,
      storageSizeBytes: JSON.stringify(this.entries).length,
      averageQueryTimeMs: 0,
    };
  }

  getHealth(): import("./memory.interface.js").MemoryHealth {
    const issues: string[] = [];
    
    if (this.entries.length > this.maxEntries * 0.9) {
      issues.push("Memory near capacity");
    }
    
    return {
      healthy: issues.length === 0,
      issues,
      storageUsagePercent: this.entries.length / this.maxEntries,
      indexHealth: "healthy",
    };
  }

  async export(options?: { 
    types?: import("./memory.interface.js").MemoryEntryType[]; 
    after?: TimestampMs; 
    before?: TimestampMs;
  }): Promise<Result<JsonObject, Error>> {
    try {
      let entries = this.entries;
      
      if (options?.types) {
        entries = entries.filter(e => options.types!.includes(e.type));
      }
      if (options?.after) {
        entries = entries.filter(e => e.createdAt >= options.after!);
      }
      if (options?.before) {
        entries = entries.filter(e => e.createdAt <= options.before!);
      }
      
      return ok({
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: entries.map(e => ({
          id: e.id as string,
          type: e.type,
          content: e.content,
          createdAt: e.createdAt as number,
          lastAccessedAt: e.lastAccessedAt as number | undefined,
          tags: e.tags,
          importance: e.importance,
          accessCount: e.accessCount,
          archived: e.archived,
          metadata: e.metadata as unknown as Record<string, unknown>,
        })),
      } as unknown as JsonObject);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async import(data: JsonObject): Promise<Result<number, Error>> {
    try {
      if (typeof data !== "object" || data === null || !Array.isArray(data.entries)) {
        return err(new Error("Invalid import data format"));
      }
      
      let imported = 0;
      for (const e of data.entries as Array<Record<string, unknown>>) {
        if (e.id && e.type && e.content) {
          const entry = {
            id: createBrand(String(e.id), "MemoryId" as const),
            type: e.type as MemoryEntry["type"],
            content: String(e.content),
            createdAt: createBrand(Number(e.createdAt) || Date.now(), "TimestampMs" as const),
            tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
            importance: (e.importance as MemoryImportance) || "medium",
            accessCount: Number(e.accessCount) || 0,
            archived: Boolean(e.archived),
            metadata: typeof e.metadata === "object" && e.metadata !== null 
              ? e.metadata as MemoryMetadata 
              : {},
          };
          
          const terms = extractTerms(entry.content);
          this.index.addDocument(terms);
          this.entries.push(entry as unknown as MemoryEntry);
          imported++;
        }
      }
      
      this.scheduleDirtyFlush();
      return ok(imported);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // --- Internal ---

  /**
   * LRU eviction based on access patterns
   */
  private evictIfNeeded(): void {
    while (this.entries.length > this.maxEntries) {
      let evictIdx = 0;
      let oldestAccess = Infinity;

      // Find least recently accessed entry
      for (let i = 0; i < this.entries.length; i++) {
        const entryId = this.entries[i]!.id as string;
        const lastAccess = this.entryAccessCache.get(entryId) || this.entries[i]!.createdAt as number;
        
        if (lastAccess < oldestAccess) {
          oldestAccess = lastAccess;
          evictIdx = i;
        }
      }

      const removed = this.entries.splice(evictIdx, 1)[0]!;
      const removedTerms = extractTerms(removed.content);
      this.index.removeDocument(removedTerms);
      this.entryAccessCache.delete(removed.id as string);
    }
  }

  private scheduleDirtyFlush(): void {
    this.dirty = true;
    
    if (this.pendingFlush) return;
    this.pendingFlush = true;
    
    // Debounced flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushDeadlineTimer = null;
      this.pendingFlush = false;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    
    // Ensure we flush eventually even if more changes keep coming
    if (!this.flushDeadlineTimer) {
      this.flushDeadlineTimer = setTimeout(() => {
        this.flushDeadlineTimer = null;
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        this.pendingFlush = false;
        void this.flush();
      }, MAX_FLUSH_WAIT_MS);
    }
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;

    const persisted: PersistedMemory = {
      version: 1,
      entries: this.entries.map((e) => ({
        id: e.id as string,
        type: e.type,
        chatId: "chatId" in e ? (e.chatId as string) : undefined,
        content: e.content,
        createdAt: new Date(e.createdAt as number).toISOString(),
        tags: e.tags,
        importance: e.importance,
        accessCount: e.accessCount,
        lastAccessedAt: e.lastAccessedAt ? new Date(e.lastAccessedAt as number).toISOString() : undefined,
        archived: e.archived,
      })),
      index: this.index.serialize(),
    };

    await writeFile(
      join(this.dbPath, "memory.json"),
      JSON.stringify(persisted),
      "utf-8"
    );

    this.dirty = false;
    const logger = getLogger();
    logger.debug("Memory flushed to disk", { entries: this.entries.length });
  }
}
