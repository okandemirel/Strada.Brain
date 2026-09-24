/**
 * Pattern Matcher
 * 
 * Matches errors and contexts against learned instincts and error patterns.
 * Supports exact, fuzzy, contextual, and error-code based matching.
 */

import type { LearningStorage } from "../storage/learning-storage.js";
import type {
  Instinct,
  ErrorPattern,
  PatternMatch,
  PatternMatchInput,
  InstinctStatus,
} from "../types.js";
import { CONFIDENCE_THRESHOLDS, MS_PER_DAY } from "../types.js";
import type { ScopeFilterMode } from "../types.js";
import type { IEventBus } from "../../core/event-bus.js";

// ─── Similarity Algorithms ──────────────────────────────────────────────────────

/**
 * Longest prefix of either string an edit distance is computed over.
 *
 * Lexical matching runs on every message (the whole prompt) and every tool
 * error (the whole output). A full edit-distance matrix over those blocked the
 * event loop for seconds per retrieval. Past this length the prefix decides,
 * and the result is still capped by what the FULL lengths allow (see
 * stringSimilarity), so a short pattern that merely opens a long text is not
 * scored as a copy of it.
 */
export const MAX_EDIT_DISTANCE_CHARS = 512;

/** Slack for floating-point thresholds, so a score exactly on a bar is kept. */
const THRESHOLD_EPSILON = 1e-9;

/**
 * Levenshtein edit distance between two strings, or `maxDistance + 1` as soon
 * as it is known to exceed `maxDistance`.
 *
 * Two rows over the shorter string, and only the diagonal band a distance of at
 * most `maxDistance` can pass through: O(min(n,m)) memory and
 * O(maxDistance · max(n,m)) time, where the full matrix was O(n·m) of both.
 */
export function boundedLevenshtein(a: string, b: string, maxDistance: number = Number.POSITIVE_INFINITY): number {
  // Rows run over `b`, columns over the shorter `a`.
  if (a.length > b.length) [a, b] = [b, a];
  const n = a.length;
  const m = b.length;
  // A distance never exceeds the longer length, so that is the widest band needed.
  const limit = Math.max(0, Math.min(Math.floor(maxDistance), m));
  const over = limit + 1;
  if (m - n > limit) return over;
  if (n === 0) return m;

  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j <= limit ? j : over;

  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - limit);
    const hi = Math.min(n, i + limit);
    // Cells left of the band can only hold distances above the limit.
    curr[lo - 1] = lo === 1 && i <= limit ? i : over;
    let rowMin = curr[lo - 1]!;
    const code = b.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const substitution = prev[j - 1]! + (a.charCodeAt(j - 1) === code ? 0 : 1);
      const v = Math.min(substitution, prev[j]! + 1, curr[j - 1]! + 1);
      curr[j] = v > over ? over : v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < n) curr[hi + 1] = over;
    // Every later row is at least this row's minimum: nothing can come back under.
    if (rowMin > limit) return over;
    [prev, curr] = [curr, prev];
  }
  return prev[n]! > limit ? over : prev[n]!;
}

/**
 * Normalized edit-distance similarity (0.0 - 1.0).
 *
 * Exact whenever the result is at least `minSimilarity`; below it the caller
 * only learns "below" (0 is returned), which lets the distance stop early.
 */
export function stringSimilarity(a: string, b: string, minSimilarity: number = 0): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // A distance is at least the length difference, so the full lengths bound
  // the similarity before any matrix work (a 200-char trigger against a 20 KB
  // prompt is decided here).
  const ceiling = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (ceiling + THRESHOLD_EPSILON < minSimilarity) return 0;

  const x = a.length > MAX_EDIT_DISTANCE_CHARS ? a.slice(0, MAX_EDIT_DISTANCE_CHARS) : a;
  const y = b.length > MAX_EDIT_DISTANCE_CHARS ? b.slice(0, MAX_EDIT_DISTANCE_CHARS) : b;
  const maxLength = Math.max(x.length, y.length);
  const maxDistance = Math.floor(Math.max(0, 1 - minSimilarity) * maxLength + THRESHOLD_EPSILON);
  const distance = boundedLevenshtein(x, y, maxDistance);
  if (distance > maxDistance) return 0;

  return Math.min(ceiling, 1 - distance / maxLength);
}

/** The token set cosine similarity compares (lower-cased, whitespace-split). */
function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/));
}

/** Cosine similarity between two token sets. */
function tokenCosine(tokensA: Set<string>, tokensB: Set<string>): number {
  const [small, large] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared++;
  return shared / Math.sqrt(tokensA.size * tokensB.size) || 0;
}

/**
 * The fuzzy score a 0.6·fuzzy + 0.4·cosine blend needs to reach `minScore`,
 * given its cosine part. Below it the blend misses the bar whatever the exact
 * edit distance is, so the distance is only computed down to here.
 */
function fuzzyFloorFor(minScore: number, cosine: number): number {
  return Math.max(0, (minScore - cosine * 0.4) / 0.6 - THRESHOLD_EPSILON);
}

/**
 * The lexical similarity the dedup decision uses: the same blend
 * findSimilarInstincts scores trigger patterns with (exact match wins outright).
 * Exact whenever it is at least `minScore`; below that only "below" is certain.
 */
export function combinedSimilarity(a: string, b: string, minScore: number = 0): number {
  if (a === b) return 1.0;
  const cosine = tokenCosine(tokenSet(a), tokenSet(b));
  const fuzzyFloor = fuzzyFloorFor(minScore, cosine);
  const fuzzy = fuzzyFloor > 1 ? 0 : stringSimilarity(a, b, fuzzyFloor);
  return fuzzy * 0.6 + cosine * 0.4;
}

// Re-export for backward compat (tests import from here)
export { denseCosineSimilarity as vectorCosineSimilarity } from "../../rag/vector-math.js";

// ─── Embedder Interface ──────────────────────────────────────────────────────────

/**
 * Minimal interface for an embedding provider.
 * Compatible with IEmbeddingProvider.embedOne() but kept intentionally narrow
 * to avoid coupling PatternMatcher to the RAG module.
 */
export interface EmbedderLike {
  embed(text: string): Promise<{ vector: number[]; dimensions: number }>;
}

/** The batch-provider shape the adapter needs (IEmbeddingProvider, without importing the RAG module). */
export interface BatchEmbedderLike {
  embed(texts: string[]): Promise<{ embeddings: readonly (readonly number[])[] }>;
}

/**
 * Adapt a batch embedding provider (IEmbeddingProvider) to the single-text
 * EmbedderLike this matcher reads.
 *
 * Both production matchers (bootstrap's and the pipeline's own) were built
 * WITHOUT an embedder while the pipeline paid to embed and store a vector for
 * every instinct it created — the only reader of those vectors is gated on
 * `this.embedder`, so semantic retrieval never ran and the boot notice implied
 * it did whenever a provider was present. The shapes differ (batch vs single),
 * which is why the wiring was never done. Audited 2026-09-02.
 */
export function embedderFromProvider(provider: BatchEmbedderLike): EmbedderLike {
  return {
    async embed(text: string) {
      const batch = await provider.embed([text]);
      const vector = [...(batch.embeddings[0] ?? [])];
      return { vector, dimensions: vector.length };
    },
  };
}

/** Scope context for cross-session filtered retrieval */
export interface ScopeContext {
  projectPath: string;
  scopeFilter: ScopeFilterMode;
  /**
   * Identity the retrieval happens for (item 3.1 / audit 04.4 / D42). User-scoped
   * instincts owned by somebody else are never candidates; without it the
   * candidate set holds only shared (project/global) and unowned learning.
   */
  userId?: string;
  maxAgeDays?: number;
  recencyBoost: number;   // default 1.0
  scopeBoost: number;     // default 1.1
  currentBootCount?: number;
  currentSessionId?: string;
}

/** Options for PatternMatcher constructor */
export interface PatternMatcherOptions {
  /** Optional embedder for semantic instinct search */
  embedder?: EmbedderLike;
  /** Optional event bus for merge event emission */
  eventBus?: import("../../core/event-bus.js").IEventBus;
}

// ─── Pattern Matcher Class ──────────────────────────────────────────────────────

export class PatternMatcher {
  private storage: LearningStorage;
  private readonly embedder?: EmbedderLike;
  private readonly eventBus?: IEventBus;
  private readonly FUZZY_THRESHOLD = 0.7;
  private readonly CONTEXTUAL_THRESHOLD = 0.5;

  constructor(storage: LearningStorage, options?: PatternMatcherOptions) {
    this.storage = storage;
    this.embedder = options?.embedder;
    this.eventBus = options?.eventBus;
  }

  /**
   * Find instincts that match a given error pattern
   * 
   * @param input - The error/context to match against
   * @param options - Matching options
   * @returns Array of pattern matches sorted by confidence
   */
  findInstinctsForError(
    input: PatternMatchInput,
    options: {
      minConfidence?: number;
      maxResults?: number;
      statusFilter?: InstinctStatus[];
      /**
       * Whose error this is. The matches become guidance in that run's tool
       * result, so another user's private instinct is never a candidate; with
       * no id only shared (project/global) and unowned learning is.
       */
      userId?: string;
    } = {}
  ): PatternMatch[] {
    const {
      minConfidence = 0.3,
      maxResults = 10,
      statusFilter = ["active", "proposed"],
      userId,
    } = options;

    // Get candidate instincts — under the same ownership clause the task-time
    // retrieval (getInstinctsForScope) applies. This path used to read every
    // row, so one user's private rule was recovery guidance for everybody.
    const candidates = this.storage.getInstincts({ visibleTo: { userId } })
      .filter(i => statusFilter.includes(i.status));

    const matches: PatternMatch[] = [];
    // The message is the whole tool output: normalize it once, not per candidate.
    const normalizedMessage = input.errorMessage ? this.normalize(input.errorMessage) : undefined;

    for (const instinct of candidates) {
      const match = this.matchInstinct(instinct, input, normalizedMessage);
      
      if (match.confidence >= minConfidence) {
        matches.push(match);
      }
    }

    // Sort by confidence descending, then by relevance
    matches.sort((a, b) => {
      const scoreA = a.confidence * 0.7 + a.relevance * 0.3;
      const scoreB = b.confidence * 0.7 + b.relevance * 0.3;
      return scoreB - scoreA;
    });

    return matches.slice(0, maxResults);
  }

  /**
   * Find similar instincts based on trigger pattern
   *
   * @param triggerPattern - The pattern to compare against
   * @param options - Matching options (with optional scope context for cross-session filtering)
   * @returns Array of similar instincts with similarity scores
   */
  async findSimilarInstincts(
    triggerPattern: string,
    options: {
      minSimilarity?: number;
      maxResults?: number;
      typeFilter?: string;
      scope?: ScopeContext;
    } = {}
  ): Promise<PatternMatch[]> {
    const {
      minSimilarity = 0.6,
      maxResults = 5,
      typeFilter,
      scope,
    } = options;

    // Choose retrieval path based on scope context
    let candidates: Instinct[];
    if (scope) {
      candidates = this.storage.getInstinctsForScope({
        projectPath: scope.projectPath,
        scopeFilter: scope.scopeFilter,
        maxAgeDays: scope.maxAgeDays,
        // item 3.1: whose learning this is. Another user's teaching is not a
        // candidate for this turn.
        ...(scope.userId ? { userId: scope.userId } : {}),
        eventBus: this.eventBus,
      });
    } else {
      candidates = this.storage.getInstincts();
    }

    if (typeFilter) {
      candidates = candidates.filter(i => i.type === typeFilter);
    }

    const matches: PatternMatch[] = [];

    // Track instinct pairs for eager dedup (scope mode only)
    const dedupCandidates: Array<{ higher: Instinct; lower: Instinct; similarity: number }> = [];

    // The query is the whole prompt: tokenize it once, not per candidate.
    const queryTokens = tokenSet(triggerPattern);
    // The lowest score anything below is discarded at: the admission bar, or in
    // scope mode the eager-dedup bar when that is lower.
    const scoreFloor = scope ? Math.min(minSimilarity, CONFIDENCE_THRESHOLDS.SIMILAR) : minSimilarity;

    for (const instinct of candidates) {
      // Calculate multiple similarity metrics
      const exactMatch = instinct.triggerPattern === triggerPattern;
      const cosineSim = tokenCosine(tokenSet(instinct.triggerPattern), queryTokens);
      const fuzzyFloor = fuzzyFloorFor(scoreFloor, cosineSim);
      const fuzzySim = exactMatch
        ? 1.0
        : fuzzyFloor > 1 ? 0 : stringSimilarity(instinct.triggerPattern, triggerPattern, fuzzyFloor);

      // Combined similarity score
      let similarity = exactMatch ? 1.0 : (fuzzySim * 0.6 + cosineSim * 0.4);
      let confidence = similarity * instinct.confidence;

      // Apply scope and recency boosts when scope context provided
      if (scope) {
        // Scope boost: multiply for same-project matches
        confidence *= scope.scopeBoost;

        // Recency boost: newer instincts get higher boost, floors at 0.5x for 1+ year old
        const ageDays = Math.max(0, Math.floor((Date.now() - instinct.createdAt) / MS_PER_DAY));
        const recencyFactor = Math.max(0.5, 1.0 - (ageDays / 365));
        confidence *= scope.recencyBoost * recencyFactor;
      }

      if (similarity >= minSimilarity) {
        matches.push({
          id: instinct.id,
          type: exactMatch ? "exact" : (fuzzySim > 0.8 ? "fuzzy" : "contextual"),
          confidence,
          relevance: similarity,
          instinct,
          matchReason: exactMatch
            ? "Exact pattern match"
            : `Similarity: ${(similarity * 100).toFixed(1)}%`,
          matchedFields: ["triggerPattern"],
          priority: Math.round(confidence * 100),
        });
      }

      // Eager dedup: check pairwise similarity between candidates (scope mode only)
      if (scope && similarity >= CONFIDENCE_THRESHOLDS.SIMILAR) {
        // Check for existing matches that are also high-similarity
        for (const existing of matches) {
          if (existing.instinct && existing.instinct.id !== instinct.id) {
            const pairScore = combinedSimilarity(
              existing.instinct.triggerPattern,
              instinct.triggerPattern,
              CONFIDENCE_THRESHOLDS.SIMILAR,
            );
            // D43 (audit 04.5): the trigger alone decided this, so two instincts
            // that fire on the same error with DIFFERENT solutions were "the same
            // instinct" and one of them was destroyed. A duplicate is the same
            // trigger AND the same action; a rival solution for a shared trigger
            // is knowledge, not noise, and stays.
            const actionScore = combinedSimilarity(existing.instinct.action, instinct.action, CONFIDENCE_THRESHOLDS.SIMILAR);
            // Round 10 #12: and the same OWNER. Two people can hold the same rule
            // privately; merging them destroys one person's learning and hands the
            // survivor to somebody who never taught it.
            const sameOwner =
              (existing.instinct.userId ?? null) === (instinct.userId ?? null);
            if (sameOwner && pairScore >= CONFIDENCE_THRESHOLDS.SIMILAR && actionScore >= CONFIDENCE_THRESHOLDS.SIMILAR) {
              const higher = existing.instinct.confidence >= instinct.confidence ? existing.instinct : instinct;
              const lower = existing.instinct.confidence >= instinct.confidence ? instinct : existing.instinct;
              dedupCandidates.push({ higher, lower, similarity: Math.min(pairScore, actionScore) });
            }
          }
        }
      }
    }

    // Merge semantic results if embedder is available (async bridge)
    if (this.embedder) {
      try {
        const { denseCosineSimilarity } = await import("../../rag/vector-math.js");
        const { vector: queryVector } = await this.embedder.embed(triggerPattern);

        for (const instinct of candidates) {
          // Skip if already matched lexically or no embedding
          if (matches.some(m => m.instinct?.id === instinct.id)) continue;
          if (!instinct.embedding || instinct.embedding.length === 0) continue;
          if (instinct.embedding.length !== queryVector.length) continue;

          const similarity = denseCosineSimilarity(queryVector, instinct.embedding);
          if (similarity >= minSimilarity) {
            let confidence = similarity * instinct.confidence;
            if (scope) {
              confidence *= scope.scopeBoost;
              const ageDays = Math.max(0, Math.floor((Date.now() - instinct.createdAt) / MS_PER_DAY));
              const recencyFactor = Math.max(0.5, 1.0 - (ageDays / 365));
              confidence *= scope.recencyBoost * recencyFactor;
            }
            matches.push({
              id: instinct.id,
              type: "semantic",
              confidence,
              relevance: similarity,
              instinct,
              matchReason: `Semantic similarity: ${(similarity * 100).toFixed(1)}%`,
              matchedFields: ["embedding"],
              priority: Math.round(confidence * 100),
            });
          }
        }
      } catch {
        // Semantic search failure is non-fatal; lexical results still returned
      }
    }

    // Execute eager dedup merges
    for (const { higher, lower, similarity: dedupSim } of dedupCandidates) {
      try {
        this.storage.mergeInstincts(higher.id, lower.id);
        // Remove merged (loser) instinct from results
        const loserIdx = matches.findIndex(m => m.instinct?.id === lower.id);
        if (loserIdx >= 0) {
          matches.splice(loserIdx, 1);
        }
        // Emit merge event
        if (this.eventBus) {
          this.eventBus.emit("instinct:merged", {
            winner: higher,
            loserId: lower.id,
            reason: `Eager dedup: ${(dedupSim * 100).toFixed(0)}% trigger+action similarity (loser soft-retired)`,
            timestamp: Date.now(),
          });
        }
      } catch {
        // Non-blocking: if merge fails, keep both instincts
      }
    }

    // Sort by combined score
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches.slice(0, maxResults);
  }

  /**
   * Find similar instincts using vector embedding cosine similarity.
   * Requires an embedder to be configured; returns empty array otherwise.
   *
   * @param query - The text to embed and search for
   * @param options - Matching options
   * @returns Array of semantically similar instincts sorted by score
   */
  async findSimilarInstinctsSemantic(
    query: string,
    options: {
      maxResults?: number;
      minScore?: number;
    } = {}
  ): Promise<PatternMatch[]> {
    if (!this.embedder) {
      return [];
    }

    const {
      maxResults = 10,
      minScore = 0.6,
    } = options;

    // Embed the query
    const { vector: queryVector } = await this.embedder.embed(query);

    // Get all instincts
    const candidates = this.storage.getInstincts();

    const { denseCosineSimilarity } = await import("../../rag/vector-math.js");
    const matches: PatternMatch[] = [];

    for (const instinct of candidates) {
      // Skip instincts without pre-computed embeddings
      if (!instinct.embedding || instinct.embedding.length === 0) {
        continue;
      }

      // Skip dimension-mismatched embeddings
      if (instinct.embedding.length !== queryVector.length) {
        continue;
      }

      const similarity = denseCosineSimilarity(queryVector, instinct.embedding);

      if (similarity >= minScore) {
        matches.push({
          id: instinct.id,
          type: "semantic",
          confidence: similarity * instinct.confidence,
          relevance: similarity,
          instinct,
          matchReason: `Semantic similarity: ${(similarity * 100).toFixed(1)}%`,
          matchedFields: ["embedding"],
          priority: Math.round(similarity * 100),
        });
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);
    return matches.slice(0, maxResults);
  }

  /**
   * Find error patterns matching the given error details
   * 
   * @param input - Error details to match
   * @returns Array of matching error patterns
   */
  findMatchingErrorPatterns(
    input: PatternMatchInput
  ): Array<{ pattern: ErrorPattern; score: number; matchType: string }> {
    const patterns = this.storage.getErrorPatterns(input.errorCategory);
    const matches: Array<{ pattern: ErrorPattern; score: number; matchType: string }> = [];

    for (const pattern of patterns) {
      let score = 0;
      const matchTypes: string[] = [];

      // Match error code
      if (input.errorCode && pattern.codePattern) {
        try {
          const codeRegex = new RegExp(pattern.codePattern, "i");
          if (codeRegex.test(input.errorCode)) {
            score += 0.4;
            matchTypes.push("error_code");
          }
        } catch {
          // Malformed regex in stored pattern — fall back to string includes
          if (input.errorCode.toLowerCase().includes(pattern.codePattern.toLowerCase())) {
            score += 0.3;
            matchTypes.push("error_code");
          }
        }
      }

      // Match error message
      if (input.errorMessage) {
        let regexMatched = false;
        try {
          const messageRegex = new RegExp(pattern.messagePattern, "i");
          regexMatched = messageRegex.test(input.errorMessage);
        } catch {
          // Malformed regex — rely on similarity only
        }
        // A regex match scores by the similarity whatever it is; otherwise only
        // a similarity above the fuzzy bar counts, so none below it is computed.
        const similarity = stringSimilarity(
          input.errorMessage,
          pattern.messagePattern,
          regexMatched ? 0 : this.FUZZY_THRESHOLD,
        );

        if (regexMatched || similarity > this.FUZZY_THRESHOLD) {
          score += 0.5 * similarity;
          matchTypes.push("message_pattern");
        }
      }

      // Match file pattern
      if (input.filePath && pattern.filePatterns.length > 0) {
        const fileMatch = pattern.filePatterns.some(fp => 
          input.filePath?.includes(fp) || 
          new RegExp(fp, "i").test(input.filePath!)
        );
        if (fileMatch) {
          score += 0.1;
          matchTypes.push("file_pattern");
        }
      }

      if (score > 0) {
        matches.push({
          pattern,
          score,
          matchType: matchTypes.join("+"),
        });
      }
    }

    // Sort by score
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  /**
   * Check if an instinct is applicable in the given context
   */
  isApplicable(instinct: Instinct, context: Record<string, unknown>): boolean {
    for (const condition of instinct.contextConditions) {
      const contextValue = context[condition.type];
      
      if (contextValue === undefined) {
        // Condition not applicable, skip
        continue;
      }

      const matches = String(contextValue).toLowerCase() === condition.value.toLowerCase();
      
      if (condition.match === "include" && !matches) {
        return false;
      }
      if (condition.match === "exclude" && matches) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get the best matching instinct for a given error
   * 
   * @param input - Error/context to match
   * @returns Best match or null if no good match found
   */
  getBestMatch(
    input: PatternMatchInput,
    minConfidence: number = 0.6
  ): PatternMatch | null {
    const matches = this.findInstinctsForError(input, { minConfidence, maxResults: 1 });
    return matches[0] ?? null;
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private matchInstinct(
    instinct: Instinct,
    input: PatternMatchInput,
    normalizedMessage?: string,
  ): PatternMatch {
    const scores: { type: PatternMatch["type"]; confidence: number; relevance: number; fields: string[] }[] = [];

    // Error code match (highest priority)
    if (input.errorCode && this.matchesErrorCode(instinct, input.errorCode)) {
      scores.push({
        type: "error_code",
        confidence: 0.95 * instinct.confidence,
        relevance: 1.0,
        fields: ["errorCode"],
      });
    }

    // Exact message match
    if (normalizedMessage !== undefined && this.matchesMessage(instinct, normalizedMessage)) {
      scores.push({
        type: "exact",
        confidence: 0.9 * instinct.confidence,
        relevance: 0.95,
        fields: ["errorMessage"],
      });
    }

    // Fuzzy message match
    if (input.errorMessage) {
      const similarity = stringSimilarity(instinct.triggerPattern, input.errorMessage, this.FUZZY_THRESHOLD);
      if (similarity >= this.FUZZY_THRESHOLD) {
        scores.push({
          type: "fuzzy",
          confidence: similarity * 0.8 * instinct.confidence,
          relevance: similarity,
          fields: ["errorMessage"],
        });
      }
    }

    // Contextual match (tool, file type, etc.)
    const contextScore = this.calculateContextScore(instinct, input);
    if (contextScore >= this.CONTEXTUAL_THRESHOLD) {
      scores.push({
        type: "contextual",
        confidence: contextScore * 0.6 * instinct.confidence,
        relevance: contextScore,
        fields: ["context"],
      });
    }

    // Select best score
    const bestScore = scores.length > 0 
      ? scores.reduce((best, current) => current.confidence > best.confidence ? current : best)
      : { type: "contextual" as const, confidence: 0, relevance: 0, fields: [] };

    return {
      id: instinct.id,
      type: bestScore.type,
      confidence: bestScore.confidence,
      relevance: bestScore.relevance,
      instinct,
      matchReason: this.generateMatchReason(bestScore.type, bestScore.fields),
      matchedFields: bestScore.fields,
      priority: Math.round(bestScore.confidence * 100),
    };
  }

  private matchesErrorCode(instinct: Instinct, errorCode: string): boolean {
    return instinct.triggerPattern.includes(errorCode) ||
           instinct.contextConditions.some(c => 
             c.type === "error_code" && 
             c.value.toLowerCase() === errorCode.toLowerCase()
           );
  }

  private matchesMessage(instinct: Instinct, normalizedMessage: string): boolean {
    // Normalize and compare (the message arrives normalized)
    const normalizedPattern = this.normalize(instinct.triggerPattern);

    return normalizedMessage.includes(normalizedPattern) ||
           normalizedPattern.includes(normalizedMessage);
  }

  private calculateContextScore(instinct: Instinct, input: PatternMatchInput): number {
    let score = 0;
    let conditions = 0;

    for (const condition of instinct.contextConditions) {
      conditions++;
      
      switch (condition.type) {
        case "tool_name":
          if (input.toolName && this.matchesCondition(input.toolName, condition.value)) {
            score += condition.match === "include" ? 1 : -0.5;
          }
          break;
        case "file_type":
          if (input.filePath) {
            const ext = input.filePath.split(".").pop() ?? "";
            if (this.matchesCondition(ext, condition.value)) {
              score += condition.match === "include" ? 1 : -0.5;
            }
          }
          break;
        case "error_code":
          if (input.errorCode && this.matchesCondition(input.errorCode, condition.value)) {
            score += condition.match === "include" ? 1 : -0.5;
          }
          break;
        case "custom":
          if (input.context && this.matchesCondition(String(input.context[condition.type] ?? ""), condition.value)) {
            score += condition.match === "include" ? 0.5 : -0.25;
          }
          break;
      }
    }

    return conditions > 0 ? Math.max(0, score / conditions) : 0.5;
  }

  private matchesCondition(value: string, pattern: string): boolean {
    if (pattern === "any" || pattern === "*") return true;
    return value.toLowerCase().includes(pattern.toLowerCase()) ||
           pattern.toLowerCase().includes(value.toLowerCase());
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/['"]/g, "")
      .trim();
  }

  private generateMatchReason(type: PatternMatch["type"], fields: string[]): string {
    const fieldStr = fields.join(", ");
    switch (type) {
      case "exact":
        return `Exact match on ${fieldStr}`;
      case "fuzzy":
        return `Fuzzy match on ${fieldStr}`;
      case "contextual":
        return `Contextual match on ${fieldStr}`;
      case "error_code":
        return `Error code match on ${fieldStr}`;
      default:
        return `Match on ${fieldStr}`;
    }
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────────

/**
 * Extract keywords from a text for indexing
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2)
    .filter(word => !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was",
  "one", "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new",
  "now", "old", "see", "two", "who", "boy", "did", "she", "use", "her", "way", "many",
  "oil", "sit", "set", "run", "eat", "far", "sea", "eye", "ask", "own", "say", "too",
  "any", "try", "let", "put", "say", "she", "try", "way", "own", "say", "too", "old",
  "tell", "very", "when", "much", "would", "there", "their", "what", "said", "each",
  "which", "will", "about", "if", "up", "out", "many", "then", "them", "these", "so",
  "some", "her", "would", "make", "like", "into", "him", "has", "two", "more", "very",
  "after", "words", "just", "where", "most", "get", "through", "back", "much", "go",
  "good", "new", "write", "our", "me", "man", "too", "any", "day", "same", "right",
  "look", "think", "also", "around", "another", "came", "come", "work", "three",
  "must", "because", "does", "part", "even", "place", "well", "such", "here", "take",
  "why", "things", "help", "put", "years", "different", "away", "again", "off", "went",
  "old", "number", "great", "tell", "men", "say", "small", "every", "found", "still",
  "between", "name", "should", "home", "big", "give", "air", "line", "set", "world",
  "own", "under", "last", "read", "never", "us", "left", "end", "along", "while",
  "might", "next", "sound", "below", "saw", "something", "thought", "both", "few",
  "those", "always", "show", "large", "often", "together", "asked", "house", "dont",
  "around", "going", "dont", "school", "important", "until", "form", "food", "keep",
  "children", "feet", "land", "side", "without", "boy", "once", "animal", "life",
  "enough", "took", "four", "head", "above", "kind", "began", "almost", "live",
  "page", "got", "build", "grow", "cut", "knew", "earth", "father", "head", "stand",
  "own", "page", "should", "country", "found", "answer", "school", "grow", "study",
  "still", "learn", "plant", "cover", "food", "sun", "four", "between", "state",
  "keep", "eye", "never", "last", "let", "thought", "city", "tree", "cross", "farm",
  "hard", "start", "might", "story", "saw", "far", "sea", "draw", "left", "late",
  "run", "dont", "while", "press", "close", "night", "real", "several", "north",
]);

/**
 * Calculate Jaccard similarity between two sets
 */
export function jaccardSimilarity<T>(a: Set<T>, b: Set<T>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}
