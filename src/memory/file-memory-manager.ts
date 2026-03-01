import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  IMemoryManager,
  MemoryEntry,
  RetrievalOptions,
  RetrievalResult,
} from "./memory.interface.js";
import type { StrataProjectAnalysis } from "../intelligence/strata-analyzer.js";
import {
  TextIndex,
  extractTerms,
  cosineSimilarity,
} from "./text-index.js";
import { getLogger } from "../utils/logger.js";

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MIN_SCORE = 0.1;
const DEFAULT_LIMIT = 5;
const DEFAULT_ANALYSIS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const FLUSH_DEBOUNCE_MS = 5000;

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
  }>;
  index: { df: Record<string, number>; docCount: number };
}

/** Persisted analysis cache */
interface PersistedAnalysis {
  projectPath: string;
  analysis: StrataProjectAnalysis & { analyzedAt: string };
}

/**
 * File-based memory manager using JSON storage and TF-IDF retrieval.
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
  private index = new TextIndex();
  private cachedAnalysis: { projectPath: string; analysis: StrataProjectAnalysis } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(dbPath: string, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.dbPath = dbPath;
    this.maxEntries = maxEntries;
  }

  async initialize(): Promise<void> {
    await mkdir(this.dbPath, { recursive: true });

    // Load memory entries
    try {
      const raw = await readFile(join(this.dbPath, "memory.json"), "utf-8");
      const data = JSON.parse(raw) as PersistedMemory;

      if (data.version === 1) {
        this.entries = data.entries.map((e) => ({
          ...e,
          createdAt: new Date(e.createdAt),
          termVector: {}, // Will be recomputed
        }));

        // Rebuild index and term vectors
        this.index = TextIndex.deserialize(data.index);
        for (const entry of this.entries) {
          const terms = extractTerms(entry.content);
          entry.termVector = this.index.computeTFIDF(terms);
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
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      await this.flush();
    }
  }

  // --- Project Analysis Cache ---

  async cacheAnalysis(
    analysis: StrataProjectAnalysis,
    projectPath: string
  ): Promise<void> {
    this.cachedAnalysis = { projectPath, analysis };

    const persisted: PersistedAnalysis = {
      projectPath,
      analysis: {
        ...analysis,
        analyzedAt: analysis.analyzedAt.toISOString() as unknown as Date & string,
      },
    };

    await writeFile(
      join(this.dbPath, "analysis.json"),
      JSON.stringify(persisted, null, 2),
      "utf-8"
    );
  }

  async getCachedAnalysis(
    projectPath: string,
    maxAgeMs: number = DEFAULT_ANALYSIS_MAX_AGE_MS
  ): Promise<StrataProjectAnalysis | null> {
    if (!this.cachedAnalysis) return null;
    if (this.cachedAnalysis.projectPath !== projectPath) return null;

    const age = Date.now() - this.cachedAnalysis.analysis.analyzedAt.getTime();
    if (age > maxAgeMs) return null;

    return this.cachedAnalysis.analysis;
  }

  // --- Conversation Memory ---

  async storeConversation(
    chatId: string,
    summary: string,
    tags: string[] = []
  ): Promise<void> {
    await this.addEntry({
      type: "conversation",
      chatId,
      content: summary,
      tags,
    });
  }

  async storeNote(content: string, tags: string[] = []): Promise<void> {
    await this.addEntry({ type: "note", content, tags });
  }

  // --- Retrieval ---

  async retrieve(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<RetrievalResult[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

    // Compute query vector
    const queryTerms = extractTerms(query);
    if (queryTerms.length === 0) return [];

    const queryVector = this.index.computeTFIDF(queryTerms);

    // Score all entries
    const scored: RetrievalResult[] = [];

    for (const entry of this.entries) {
      // Apply filters
      if (options.chatId && entry.chatId !== options.chatId) continue;
      if (options.type && entry.type !== options.type) continue;

      const score = cosineSimilarity(queryVector, entry.termVector);
      if (score >= minScore) {
        scored.push({ entry, score });
      }
    }

    // Sort by score descending, take top-k
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async getChatHistory(
    chatId: string,
    limit: number = 10
  ): Promise<MemoryEntry[]> {
    return this.entries
      .filter((e) => e.chatId === chatId)
      .slice(-limit);
  }

  // --- Stats ---

  getStats(): {
    totalEntries: number;
    conversationCount: number;
    noteCount: number;
    hasAnalysisCache: boolean;
  } {
    return {
      totalEntries: this.entries.length,
      conversationCount: this.entries.filter((e) => e.type === "conversation").length,
      noteCount: this.entries.filter((e) => e.type === "note").length,
      hasAnalysisCache: this.cachedAnalysis !== null,
    };
  }

  // --- Internal ---

  private async addEntry(opts: {
    type: MemoryEntry["type"];
    chatId?: string;
    content: string;
    tags: string[];
  }): Promise<void> {
    const terms = extractTerms(opts.content);
    this.index.addDocument(terms);
    const termVector = this.index.computeTFIDF(terms);

    const entry: MemoryEntry = {
      id: randomUUID(),
      type: opts.type,
      chatId: opts.chatId,
      content: opts.content,
      createdAt: new Date(),
      termVector,
      tags: opts.tags,
    };

    this.entries.push(entry);

    // Evict oldest entries if over capacity
    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift()!;
      const removedTerms = extractTerms(removed.content);
      this.index.removeDocument(removedTerms);
    }

    this.scheduleDirtyFlush();
  }

  private scheduleDirtyFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;

    const persisted: PersistedMemory = {
      version: 1,
      entries: this.entries.map((e) => ({
        id: e.id,
        type: e.type,
        chatId: e.chatId,
        content: e.content,
        createdAt: e.createdAt.toISOString(),
        tags: e.tags,
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
