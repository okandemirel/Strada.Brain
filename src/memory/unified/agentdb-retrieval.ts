/**
 * AgentDB Retrieval Helpers
 *
 * Extracted from AgentDBMemory — standalone functions for semantic search,
 * hybrid retrieval, and MMR re-ranking.
 */

import type {
  UnifiedMemoryConfig,
  UnifiedMemoryEntry,
  UnifiedMemoryQuery,
} from "./unified-memory.interface.js";
import type { HNSWVectorStore } from "../../rag/hnsw/hnsw-vector-store.js";
import type { RetrievalOptions, RetrievalResult, MemoryEntry } from "../memory.interface.js";
import type { NormalizedScore } from "../../types/index.js";
import { MemoryTier } from "./unified-memory.interface.js";
import { TextIndex, extractTerms, cosineSimilarity } from "../text-index.js";
import { getLogger } from "../../utils/logger.js";

function getLoggerSafe() {
  try { return getLogger(); } catch { return console; }
}
import { generateEmbedding } from "./agentdb-vector.js";
import { getNow } from "./agentdb-time.js";

// ---------------------------------------------------------------------------
// Context required by retrieval helpers
// ---------------------------------------------------------------------------

export interface AgentDBRetrievalContext {
  readonly config: UnifiedMemoryConfig;
  readonly entries: Map<string, UnifiedMemoryEntry>;
  readonly hnswStore: HNSWVectorStore | undefined;
  readonly textIndex: TextIndex;
  readonly searchTimes: number[];
  /** Optional callback to persist an entry after access stats update. */
  readonly sqlitePersistEntry?: (entry: UnifiedMemoryEntry) => void;
}

// ---------------------------------------------------------------------------
// TF-IDF retrieval (backward compatibility)
// ---------------------------------------------------------------------------

/** TF-IDF based retrieval for backward compatibility. */
export function retrieveTFIDF(
  ctx: AgentDBRetrievalContext,
  query: string,
  options: RetrievalOptions,
): RetrievalResult<MemoryEntry>[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0.1;

  const queryTerms = extractTerms(query);
  if (queryTerms.length === 0) return [];

  const queryVector = ctx.textIndex.computeTFIDF(queryTerms);

  const scored: RetrievalResult<MemoryEntry>[] = [];

  for (const entry of ctx.entries.values()) {
    // Apply filters based on RetrievalOptions mode
    if (options.mode === "chat" && "chatId" in entry && entry.chatId !== options.chatId) continue;
    if (options.mode === "type" && options.types && !options.types.includes(entry.type)) continue;

    // Compute TF-IDF similarity
    const entryTerms = extractTerms(entry.content);
    const entryVector = ctx.textIndex.computeTFIDF(entryTerms);
    const score = cosineSimilarity(queryVector, entryVector);

    if (score >= minScore) {
      scored.push({ entry: entry as unknown as MemoryEntry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Semantic retrieval (HNSW)
// ---------------------------------------------------------------------------

/** HNSW-based semantic search with optional MMR. */
export async function retrieveSemantic(
  ctx: AgentDBRetrievalContext,
  query: string,
  options: UnifiedMemoryQuery = {},
): Promise<RetrievalResult<MemoryEntry>[]> {
  if (!ctx.hnswStore) {
    // Fallback to TF-IDF
    return retrieveTFIDF(ctx, query, options as RetrievalOptions);
  }

  const startTime = performance.now();

  // Generate query embedding
  const queryEmbedding = options.embedding ?? (await generateEmbedding(ctx.config, query));

  // Search HNSW index
  const hnswResults = await ctx.hnswStore.search(queryEmbedding, (options.limit ?? 5) * 2);

  // Convert to RetrievalResult format
  const results: RetrievalResult<MemoryEntry>[] = [];

  for (const hit of hnswResults) {
    const entry = ctx.entries.get(hit.chunk.id);
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

    // NOTE: Race condition — in-memory read-modify-write is not atomic.
    // The retrieval context does not expose direct DB access, so an atomic
    // SQL increment (access_count = access_count + 1) is not possible here.
    // Under concurrent retrievals the count may drift, but this is acceptable
    // for access-frequency heuristics.  A future refactor could add a
    // dedicated `sqliteIncrementAccessCount` callback to AgentDBRetrievalContext.
    entry.accessCount++;
    entry.lastAccessedAt = getNow();
    ctx.sqlitePersistEntry?.(entry);

    results.push({
      entry: entry as unknown as MemoryEntry,
      score: hit.score,
    });
  }

  // Record search time for all paths
  const searchTime = performance.now() - startTime;
  ctx.searchTimes.push(searchTime);
  if (ctx.searchTimes.length > 100) ctx.searchTimes.shift();

  // Apply MMR if requested
  if (options.useMMR) {
    return applyMMR(results, queryEmbedding, options.mmrLambda ?? 0.5, options.limit ?? 5);
  }

  return results.slice(0, options.limit ?? 5);
}

// ---------------------------------------------------------------------------
// Hybrid retrieval (semantic + TF-IDF)
// ---------------------------------------------------------------------------

/** Combined semantic + keyword search with weighted merging. */
export async function retrieveHybrid(
  ctx: AgentDBRetrievalContext,
  query: string,
  options?: {
    semanticWeight?: NormalizedScore;
    tier?: MemoryTier;
    limit?: number;
    useMMR?: boolean;
  },
): Promise<RetrievalResult<MemoryEntry>[]> {
  try {
    // Get both semantic and text results
    const [semanticResults, textResults] = await Promise.all([
      retrieveSemantic(ctx, query, { limit: (options?.limit ?? 5) * 2, tier: options?.tier }),
      Promise.resolve(retrieveTFIDF(ctx, query, { mode: "text", query, limit: (options?.limit ?? 5) * 2 })),
    ]);

    const semanticWeight = options?.semanticWeight ?? 0.7;
    const textWeight = 1 - semanticWeight;

    // Merge results with weights
    const scores = new Map<
      string,
      { entry: MemoryEntry; score: number }
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

// ---------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance)
// ---------------------------------------------------------------------------

/** Local cosine similarity for MMR computation (operates on raw number arrays). */
function mmrCosineSimilarity(a: number[], b: number[]): number {
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

/** Apply Maximal Marginal Relevance re-ranking for diverse results. */
export function applyMMR(
  results: RetrievalResult<MemoryEntry>[],
  _queryEmbedding: number[],
  lambda: number,
  limit: number,
): RetrievalResult<MemoryEntry>[] {
  if (results.length === 0) return [];

  const selected: RetrievalResult<MemoryEntry>[] = [];
  const remaining = [...results];

  while (selected.length < limit && remaining.length > 0) {
    let bestScore = -Infinity;
    let bestIndex = 0;

    for (let i = 0; i < remaining.length; i++) {
      const result = remaining[i]!;

      // Relevance score
      const relevance = result.score;

      // Diversity score (max similarity to already selected)
      let maxSim = 0;
      for (const sel of selected) {
        const selEmbedding = (sel.entry as unknown as UnifiedMemoryEntry).embedding;
        const resultEmbedding = (result.entry as unknown as UnifiedMemoryEntry).embedding;
        if (!selEmbedding?.length || !resultEmbedding?.length) continue;
        const sim = mmrCosineSimilarity(resultEmbedding, selEmbedding);
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
