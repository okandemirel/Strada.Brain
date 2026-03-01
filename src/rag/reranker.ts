import type { VectorSearchHit, RAGSearchResult } from "./rag.interface.js";

interface RerankerConfig {
  vectorWeight: number;
  keywordWeight: number;
  structuralWeight: number;
}

const DEFAULT_CONFIG: RerankerConfig = {
  vectorWeight: 0.6,
  keywordWeight: 0.25,
  structuralWeight: 0.15,
};

/**
 * Extract normalised query terms: lowercase, split on non-alphanumeric,
 * drop tokens shorter than 2 characters.
 */
function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Compute the fraction of query terms that appear (as a substring) in the
 * chunk content (case-insensitive).
 */
function computeKeywordScore(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lowerContent = content.toLowerCase();
  const matched = terms.filter((t) => lowerContent.includes(t)).length;
  return matched / terms.length;
}

/**
 * Domain-specific structural boost for Unity / ECS C# code:
 *  +0.3  class or struct kind
 *  +0.5  symbol name matches any query term
 *  +0.1  symbol ends with "System"
 *  +0.2  content contains "IComponent"
 *
 * The total is clamped to [0, 1] so it behaves well as a weighted input.
 */
function computeStructuralScore(
  chunk: VectorSearchHit["chunk"],
  terms: string[]
): number {
  let score = 0;

  if (chunk.kind === "class" || chunk.kind === "struct") {
    score += 0.3;
  }

  if (chunk.symbol) {
    const lowerSymbol = chunk.symbol.toLowerCase();
    if (terms.some((t) => lowerSymbol.includes(t))) {
      score += 0.5;
    }
    if (chunk.symbol.endsWith("System")) {
      score += 0.1;
    }
  }

  if (chunk.content.includes("IComponent")) {
    score += 0.2;
  }

  return Math.min(score, 1);
}

/**
 * Re-rank raw vector-search candidates using a weighted combination of
 * vector similarity, keyword overlap, and structural heuristics.
 *
 * Returns results sorted by finalScore descending.
 */
export function rerankResults(
  candidates: VectorSearchHit[],
  query: string,
  config?: Partial<RerankerConfig>
): RAGSearchResult[] {
  if (candidates.length === 0) return [];

  const cfg: RerankerConfig = { ...DEFAULT_CONFIG, ...config };
  const terms = extractQueryTerms(query);

  const results: RAGSearchResult[] = candidates.map((hit) => {
    const keywordScore = computeKeywordScore(hit.chunk.content, terms);
    const structuralScore = computeStructuralScore(hit.chunk, terms);
    const finalScore =
      cfg.vectorWeight * hit.score +
      cfg.keywordWeight * keywordScore +
      cfg.structuralWeight * structuralScore;

    return {
      chunk: hit.chunk,
      vectorScore: hit.score,
      finalScore,
    };
  });

  results.sort((a, b) => b.finalScore - a.finalScore);
  return results;
}
