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
  /** Restrict candidates (Codex round 7 #21: rows the provider index cannot serve yet). */
  candidate?: (entry: UnifiedMemoryEntry) => boolean,
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
    if (candidate && !candidate(entry)) continue;
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
// Rank fusion across scorers
// ---------------------------------------------------------------------------

/** Reciprocal-rank-fusion constant (the standard k = 60). */
const RRF_K = 60;

/**
 * Fuse lists produced by DIFFERENT scorers (finding 18).
 *
 * A raw TF-IDF cosine and a provider-embedding cosine are not the same
 * measurement: the two are calibrated differently, so sorting them in one
 * array let the scorers' unrelated magnitudes — not the evidence — decide
 * which rows survived. Reciprocal rank fusion compares only each row's
 * POSITION inside the list that produced it, which is the one thing the two
 * scorers agree on the meaning of.
 *
 * `lists[0]` is the primary list (the provider index); it also breaks ties,
 * so a row the index ranked stays ahead of a text-only row of equal fused
 * weight. The fused weight is normalized by the maximum a row could reach
 * (top of every list) so scores stay on the [0, 1] scale callers and MMR's
 * lambda expect from a similarity.
 */
function fuseRankedLists(
  lists: ReadonlyArray<ReadonlyArray<RetrievalResult<MemoryEntry>>>,
): RetrievalResult<MemoryEntry>[] {
  const fused = new Map<
    string,
    { hit: RetrievalResult<MemoryEntry>; weight: number; primaryRank: number }
  >();
  for (let li = 0; li < lists.length; li++) {
    const list = lists[li]!;
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank]!;
      const id = hit.entry.id as string;
      const contribution = 1 / (RRF_K + rank + 1);
      const primaryRank = li === 0 ? rank : Number.MAX_SAFE_INTEGER;
      const existing = fused.get(id);
      if (existing) {
        existing.weight += contribution;
        existing.primaryRank = Math.min(existing.primaryRank, primaryRank);
      } else {
        fused.set(id, { hit, weight: contribution, primaryRank });
      }
    }
  }
  const maxWeight = lists.length / (RRF_K + 1);
  return Array.from(fused.values())
    .sort((a, b) => b.weight - a.weight || a.primaryRank - b.primaryRank)
    .map((f) => ({ ...f.hit, score: (f.weight / maxWeight) as NormalizedScore }));
}

// ---------------------------------------------------------------------------
// Semantic retrieval (HNSW)
// ---------------------------------------------------------------------------

/** HNSW-based semantic search with optional MMR. */
/**
 * Count one access for each entry a caller actually receives. Counting every
 * candidate of the over-fetch window inflated the counts that drive promotion
 * and eviction, and re-persisted rows nobody was shown (MEM-22).
 */
function recordAccess(ctx: AgentDBRetrievalContext, hits: readonly RetrievalResult<MemoryEntry>[]): void {
  const now = getNow();
  for (const hit of hits) {
    const entry = ctx.entries.get(hit.entry.id as string);
    if (!entry) continue;
    // NOTE: Race condition — in-memory read-modify-write is not atomic.
    // The retrieval context does not expose direct DB access, so an atomic
    // SQL increment (access_count = access_count + 1) is not possible here.
    // Under concurrent retrievals the count may drift, but this is acceptable
    // for access-frequency heuristics.
    entry.accessCount++;
    entry.lastAccessedAt = now;
    ctx.sqlitePersistEntry?.(entry);
  }
}

/**
 * @param countAccess false when the caller re-ranks and cuts the results
 *   itself (retrieveHybrid) and records access for its own final set.
 */
export async function retrieveSemantic(
  ctx: AgentDBRetrievalContext,
  query: string,
  options: UnifiedMemoryQuery = {},
  countAccess = true,
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

  // Kept apart from the text-fallback list below: the two carry scores from
  // different scorers and are fused by rank, never sorted together (finding 18).
  const vectorHits: RetrievalResult<MemoryEntry>[] = [];
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

      vectorHits.push({
        entry: entry as unknown as MemoryEntry,
        score: hit.score,
      });
    }

    // Enough eligible hits, an unfiltered query (one window is exact), the
    // index gave back fewer than asked (exhausted), or the window already
    // covered the whole index.
    if (vectorHits.length >= limit || !filtered) break;
    if (hnswResults.length < candidateCount || candidateCount >= indexSize) break;
    candidateCount = Math.min(candidateCount * 4, indexSize);
  }

  // Codex round 7 #21: while vectors of another origin (histogram, unknown,
  // foreign provider) are being re-embedded, the provider index holds fewer
  // rows than the store and semantic recall returned nothing from the rest.
  // Serve those rows through the scoped text path and merge — both scores
  // are cosine similarities in [0, 1] — so a 50k-row migration does not
  // blank out recall for hours. Rows with no vector at all are not "awaiting
  // migration" and are left to the text-only paths as before.
  const awaiting = (entry: UnifiedMemoryEntry): boolean => awaitingMigration(entry, expectedProvenance);
  const textHits: RetrievalResult<MemoryEntry>[] = [];
  if (query.length > 0 && hasAwaitingMigration(ctx, expectedProvenance)) {
    for (const hit of retrieveTFIDF(ctx, query, { ...options, limit }, awaiting)) {
      const id = hit.entry.id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      textHits.push(hit);
    }
  }

  vectorHits.sort((a, b) => (b.score as number) - (a.score as number));

  // Finding 18: the merge used to sort raw TF-IDF cosines against provider
  // cosines ("both are cosine similarities in [0, 1]" — same range, different
  // calibration), so the survivors depended on the scorers' unrelated scales.
  // Rank fusion when both scorers contributed; with only the index list the
  // scores are already comparable and are passed through exactly as reported.
  // …and with only ONE non-empty list there is nothing to reconcile: fusing it
  // with an empty one replaced comparable scores with rank weights and changed
  // the order MMR then selected from (Codex round 9 #10).
  const results = vectorHits.length > 0 && textHits.length > 0
    ? fuseRankedLists([vectorHits, textHits])
    : textHits.length > 0 ? textHits : vectorHits;

  // Record search time for all paths
  const searchTime = performance.now() - startTime;
  ctx.searchTimes.push(searchTime);
  if (ctx.searchTimes.length > 100) ctx.searchTimes.shift();

  // Apply MMR if requested
  const selected = options.useMMR
    ? applyMMR(
      results,
      queryEmbedding,
      options.mmrLambda ?? 0.5,
      options.limit ?? 5,
      expectedProvenance,
    )
    : results.slice(0, options.limit ?? 5);
  if (countAccess) recordAccess(ctx, selected);
  return selected.map(sanitizeResult);
}

/**
 * True when the row carries a vector the provider index cannot hold
 * (Codex round 7 #21): a provenance other than the index's. Such a row is
 * queued for `reEmbedHashEntries` and, until then, is served by text.
 */
export function awaitingMigration(
  entry: { embedding?: readonly number[] | null; embeddingProvenance?: EmbeddingProvenance },
  expected: EmbeddingProvenance,
): boolean {
  if (!entry.embedding || entry.embedding.length === 0) return false;
  return entry.embeddingProvenance !== undefined && entry.embeddingProvenance !== expected;
}

/** True when the provider index holds fewer eligible rows than the store. */
function hasAwaitingMigration(ctx: AgentDBRetrievalContext, expected: EmbeddingProvenance): boolean {
  for (const entry of ctx.entries.values()) {
    if (awaitingMigration(entry, expected)) return true;
  }
  return false;
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
      retrieveSemantic(ctx, query, shared, false),
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

    const hits = merged.map((m) => ({ entry: m.entry, score: m.score }));
    // Only the semantic half used to count accesses, for all 2x limit of its
    // candidates; count the entries this call returns instead (MEM-22).
    recordAccess(ctx, hits);
    return hits;
  } catch (error) {
    getLoggerSafe().error("[AgentDBMemory] Hybrid retrieval failed", { error: String(error) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance)
// ---------------------------------------------------------------------------

/**
 * Redundancy between two candidates when a vector comparison is not available
 * (finding 18): Jaccard overlap of the two contents' terms. Used for any pair
 * where at least one row's embedding is not in the query's space — a row from
 * the text fallback keeps its FOREIGN vector, and a cosine against a vector
 * from another provider/model is not a similarity at all.
 */
function termOverlap(a: string, b: string): number {
  const termsA = new Set(extractTerms(a));
  const termsB = new Set(extractTerms(b));
  if (termsA.size === 0 || termsB.size === 0) return 0;
  let shared = 0;
  for (const term of termsA) {
    if (termsB.has(term)) shared++;
  }
  return shared / (termsA.size + termsB.size - shared);
}

/**
 * The row's embedding, but only when it is comparable to the query's. Same
 * notion of "same provenance" the HNSW path gates on (`awaitingMigration`) —
 * there is exactly one definition of a comparable vector in this module.
 * `expected === undefined` means the caller did not state a provenance
 * (direct applyMMR callers), and every vector is taken at face value as before.
 */
function comparableVector(
  entry: UnifiedMemoryEntry,
  expected: EmbeddingProvenance | undefined,
): number[] | undefined {
  const embedding = entry.embedding as number[] | undefined;
  if (!embedding?.length) return undefined;
  if (expected !== undefined && awaitingMigration(entry, expected)) return undefined;
  return embedding;
}

/** ONE comparable representation per pair: vectors when both are in the query's space, else terms. */
function mmrRedundancy(
  a: UnifiedMemoryEntry,
  b: UnifiedMemoryEntry,
  expected: EmbeddingProvenance | undefined,
): number {
  const va = comparableVector(a, expected);
  const vb = comparableVector(b, expected);
  if (va && vb && va.length === vb.length) return mmrCosineSimilarity(va, vb);
  return termOverlap(a.content, b.content);
}

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

/**
 * Apply Maximal Marginal Relevance re-ranking for diverse results.
 *
 * `expectedProvenance` is the query embedding's provenance. Pass it and the
 * diversity step compares vectors ONLY between rows that live in that space;
 * every other pair falls back to term overlap (finding 18). Omit it and every
 * vector is compared, as before.
 */
export function applyMMR(
  results: RetrievalResult<MemoryEntry>[],
  _queryEmbedding: number[],
  lambda: number,
  limit: number,
  expectedProvenance?: EmbeddingProvenance,
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

      // Diversity score (max redundancy against what is already selected).
      // A foreign vector must never decide this (finding 18): mmrRedundancy
      // uses vectors only where both rows share the query's provenance.
      let maxSim = 0;
      for (const sel of selected) {
        const sim = mmrRedundancy(
          result.entry as unknown as UnifiedMemoryEntry,
          sel.entry as unknown as UnifiedMemoryEntry,
          expectedProvenance,
        );
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
