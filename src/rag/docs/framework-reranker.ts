/**
 * Framework-Aware Reranker
 *
 * Extends the base reranker with source priority boosting for framework docs.
 * Framework documentation is ranked higher than project code.
 */

import type { SearchResult, Chunk, VectorSearchHit } from "../rag.interface.js";
import { isDocumentationChunk } from "../rag.interface.js";
import type { NormalizedScore } from "../../types/index.js";
import { isFrameworkDocChunk, DOC_SOURCE_PRIORITY } from "./doc-rag.interface.js";

export interface FrameworkRerankerConfig {
  readonly vectorWeight: number;
  readonly keywordWeight: number;
  readonly structuralWeight: number;
  readonly sourceBoostWeight: number;
  readonly recencyWeight: number;
}

export const DEFAULT_FRAMEWORK_RERANKER_CONFIG: FrameworkRerankerConfig = {
  vectorWeight: 0.50,
  keywordWeight: 0.20,
  structuralWeight: 0.10,
  sourceBoostWeight: 0.15,
  recencyWeight: 0.05,
};

/**
 * Extract query terms for keyword matching.
 */
function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Compute keyword score: fraction of query terms found in content.
 */
function computeKeywordScore(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = content.toLowerCase();
  return terms.filter((t) => lower.includes(t)).length / terms.length;
}

/**
 * Compute source priority score based on DocSourceType.
 */
function computeSourceScore(chunk: Chunk): number {
  if (isFrameworkDocChunk(chunk)) {
    return DOC_SOURCE_PRIORITY[chunk.docSource] ?? 0.5;
  }
  if (isDocumentationChunk(chunk)) {
    return 0.45; // Generic documentation
  }
  return 0.50; // Code chunks
}

/**
 * Structural score: boost for doc chunks with matching titles/symbols.
 */
function computeStructuralScore(chunk: Chunk, terms: string[]): number {
  let score = 0;

  if (isDocumentationChunk(chunk)) {
    if (chunk.title) {
      const lowerTitle = chunk.title.toLowerCase();
      if (terms.some((t) => lowerTitle.includes(t))) score += 0.5;
    }
    if (chunk.hierarchy) {
      const hierStr = chunk.hierarchy.join(" ").toLowerCase();
      if (terms.some((t) => hierStr.includes(t))) score += 0.3;
    }
  }

  return Math.min(1, score);
}

/**
 * Rerank search results with framework-aware priority boosting.
 */
export function rerankWithFrameworkPriority(
  query: string,
  hits: VectorSearchHit[],
  config: FrameworkRerankerConfig = DEFAULT_FRAMEWORK_RERANKER_CONFIG,
): SearchResult[] {
  const terms = extractQueryTerms(query);

  const results: SearchResult[] = hits.map((hit) => {
    const keywordScore = computeKeywordScore(hit.chunk.content, terms);
    const sourceScore = computeSourceScore(hit.chunk);
    const structuralScore = computeStructuralScore(hit.chunk, terms);

    const finalScore =
      config.vectorWeight * hit.score +
      config.keywordWeight * keywordScore +
      config.structuralWeight * structuralScore +
      config.sourceBoostWeight * sourceScore +
      config.recencyWeight * 0.5; // Neutral recency for now

    return {
      chunk: hit.chunk,
      vectorScore: hit.score,
      finalScore: Math.min(1, finalScore) as NormalizedScore,
      matchedKeywords: terms.filter((t) => hit.chunk.content.toLowerCase().includes(t)),
    };
  });

  return results.sort((a, b) => b.finalScore - a.finalScore);
}
