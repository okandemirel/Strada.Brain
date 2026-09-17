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
import type { RetrievalResult, MemoryEntry } from "../memory.interface.js";
import type { NormalizedScore } from "../../types/index.js";
import { MemoryTier } from "./unified-memory.interface.js";
import { TextIndex, extractTerms, cosineSimilarity } from "../text-index.js";
import { getLogger } from "../../utils/logger.js";
import { sanitizeRetrievalContent } from "../../agents/orchestrator-text-utils.js";

function getLoggerSafe() {
  try { return getLogger(); } catch { return console; }
}
import { embedWithProvenance, indexProvenance } from "./agentdb-vector.js";
import { getNow } from "./agentdb-time.js";
import {
  hasActiveFilters,
  matchesRetrievalFilters,
  toRetrievalFilters,
} from "../retrieval-filters.js";
import type { RetrievalFilterSource } from "../retrieval-filters.js";
import type { MemoryScope } from "../memory.interface.js";
import type { EmbeddingProvenance } from "./unified-memory.interface.js";

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
// Prompt-injection defense for retrieved content
// ---------------------------------------------------------------------------
// sec-H1: Entries loaded from AgentDB are untrusted content that ultimately
// gets concatenated into the agent's system/user context. Returning a
// sanitized shallow copy means callers get defense-in-depth without mutating
// the underlying store (which would corrupt pattern-store / learning
// write paths owned by other subsystems).
//
// Every hit goes through `sanitizeRetrievalContent`, whatever its length.
// A "benign short content" fast path used to return entries under 200 chars
// with no `<`/`@`/`#`/URL untouched — but the override, role-hijack and
// envelope patterns the sanitizer exists to catch ("Ignore all previous
// instructions…", "[SYSTEM] …", "From now on you are …") contain none of
// those characters, so the common short entry (note, insight, consolidation
// summary) bypassed the defense and reached the re-retrieval system-prompt
// splice (memory-refresher → orchestrator-loop-shared) verbatim. The
// sanitizer is a few regex passes over a short string; the cost never
// justified the hole. Fast path removed (audited 2026-09-02).

function sanitizeResult(hit: RetrievalResult<MemoryEntry>): RetrievalResult<MemoryEntry> {
  const content = (hit.entry as { content?: unknown }).content;
  if (typeof content !== "string") return hit;
  const safeContent = sanitizeRetrievalContent(content, "agentdb-retrieval");
  if (safeContent === content) return hit;
  return {
    ...hit,
    entry: { ...hit.entry, content: safeContent } as MemoryEntry,
  };
}

// ---------------------------------------------------------------------------
// TF-IDF retrieval (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * TF-IDF based retrieval for backward compatibility — and the text fallback
 * every vector-path failure lands on. Applies the SAME shared filter as the
 * vector path (plan 0-B.9 / 3.9): chatId, type/types, tier, domain,
 * minImportance, expiry, tags, importance, archived, time range, scope.
 * Before this it honoured only `mode: "chat"` and `mode: "type"`.
 */
export function retrieveTFIDF(
  ctx: AgentDBRetrievalContext,
  query: string,
  options: RetrievalFilterSource & { limit?: number; minScore?: number },
): RetrievalResult<MemoryEntry>[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0.1;

  const queryTerms = extractTerms(query);
  if (queryTerms.length === 0) return [];

  const queryVector = ctx.textIndex.computeTFIDF(queryTerms);
  const filters = toRetrievalFilters(options);
  const now = Date.now();

  const scored: RetrievalResult<MemoryEntry>[] = [];

  for (const entry of ctx.entries.values()) {
    // One filter layer shared with retrieveSemantic — the fallback returns
    // exactly the filtered set the vector path would have.
    if (!matchesRetrievalFilters(entry, filters, now)) continue;

    // Compute TF-IDF similarity
    const entryTerms = extractTerms(entry.content);
    const entryVector = ctx.textIndex.computeTFIDF(entryTerms);
    const score = cosineSimilarity(queryVector, entryVector);

    if (score >= minScore) {
      scored.push({ entry: entry as unknown as MemoryEntry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(sanitizeResult);
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
    // Fallback to TF-IDF — same shared filter, same result set (plan 0-B.9)
    return retrieveTFIDF(ctx, query, options);
  }

  const startTime = performance.now();

  // Generate query embedding. A caller-supplied vector is taken to be the
  // index's provenance (retrieveByEmbedding / pre-computed recall vectors).
  const expectedProvenance: EmbeddingProvenance = indexProvenance(ctx.config);
  let queryEmbedding: number[];
  let queryProvenance: EmbeddingProvenance;
  if (options.embedding) {
    queryEmbedding = options.embedding;
    queryProvenance = expectedProvenance;
  } else {
    const embedded = await embedWithProvenance(ctx.config, query);
    queryEmbedding = embedded.embedding;
    queryProvenance = embedded.provenance;
  }

  if (queryProvenance !== expectedProvenance) {
    // Provider failed for the query: a histogram query vector must never be
    // compared against provider vectors. Fall back to the text path, which
    // applies the same filters (plan 0-B.9).
    getLoggerSafe().warn(
      "[AgentDBMemory] Query embedding provenance differs from index — using TF-IDF fallback",
      { queryProvenance, indexProvenance: expectedProvenance },
    );
    return retrieveTFIDF(ctx, query, options);
  }

  const filters = toRetrievalFilters(options);
  const now = Date.now();
  const limit = options.limit ?? 5;
  const filtered = hasActiveFilters(filters);
  // Over-fetch more when a filter narrows the candidate set so the post-filter
  // still has `limit` matches to return. The window is not a fixed factor
  // (Codex round 6 #19): with limit 1 and four chat-A hits ranked above the
  // one chat-B hit, a ×4 window returned [] for scope B although a match
  // existed. It now widens ×4 per round until `limit` eligible hits are found
  // or the index is exhausted.
  const indexSize = indexElementCount(ctx);
  let candidateCount = Math.max(1, limit * (filtered ? 4 : 2));

  const results: RetrievalResult<MemoryEntry>[] = [];
  const seen = new Set<string>();

  for (;;) {
    const hnswResults = await ctx.hnswStore.search(queryEmbedding, candidateCount);

    for (const hit of hnswResults) {
      if (seen.has(hit.chunk.id)) continue;
      seen.add(hit.chunk.id);

      const entry = ctx.entries.get(hit.chunk.id);
      if (!entry) continue;

      // Provenance guard: a vector of another embedder must not be scored
      // against this query even if it somehow reached the index.
      if (entry.embeddingProvenance !== undefined && entry.embeddingProvenance !== queryProvenance) continue;

      // One filter layer shared with retrieveTFIDF (plan 0-B.9 / 3.9)
      if (!matchesRetrievalFilters(entry, filters, now)) continue;

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

    // Enough eligible hits, an unfiltered query (one window is exact), the
    // index gave back fewer than asked (exhausted), or the window already
    // covered the whole index.
    if (results.length >= limit || !filtered) break;
    if (hnswResults.length < candidateCount || candidateCount >= indexSize) break;
    candidateCount = Math.min(candidateCount * 4, indexSize);
  }

  results.sort((a, b) => (b.score as number) - (a.score as number));

  // Record search time for all paths
  const searchTime = performance.now() - startTime;
  ctx.searchTimes.push(searchTime);
  if (ctx.searchTimes.length > 100) ctx.searchTimes.shift();

  // Apply MMR if requested
  if (options.useMMR) {
    return applyMMR(results, queryEmbedding, options.mmrLambda ?? 0.5, options.limit ?? 5).map(
      sanitizeResult,
    );
  }

  return results.slice(0, options.limit ?? 5).map(sanitizeResult);
}

/**
 * Upper bound for the candidate window (Codex round 6 #19): the HNSW element
 * count when the store reports one, else the number of entries loaded.
 */
function indexElementCount(ctx: AgentDBRetrievalContext): number {
  const store = ctx.hnswStore as { count?: () => number } | undefined;
  let size: number | undefined;
  if (store && typeof store.count === "function") {
    try {
      const n = store.count();
      if (typeof n === "number" && Number.isFinite(n) && n > 0) size = n;
    } catch {
      // fall through to the entries map
    }
  }
  return Math.max(1, size ?? ctx.entries.size);
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
    /** Identity scope (plan 3.9) — applied to both halves. */
    scope?: MemoryScope;
  },
): Promise<RetrievalResult<MemoryEntry>[]> {
  try {
    // Get both semantic and text results — same filters on both halves
    const shared = { limit: (options?.limit ?? 5) * 2, tier: options?.tier, scope: options?.scope };
    const [semanticResults, textResults] = await Promise.all([
      retrieveSemantic(ctx, query, shared),
      Promise.resolve(retrieveTFIDF(ctx, query, { mode: "text", query, ...shared })),
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
