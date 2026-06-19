/**
 * Hash-based fallback embedding provider.
 *
 * Deterministic, dependency-free, zero-network embedder using the "hashing
 * trick" (feature hashing): each token is hashed into one of `dimensions`
 * buckets with a signed contribution, and the resulting bag-of-tokens vector
 * is L2-normalized.
 *
 * This is NOT a semantic embedder — two paraphrases that share no tokens get
 * unrelated vectors. Its purpose is graceful degradation: it lets the Codebase
 * Memory Vault (and any other embedding consumer) ALWAYS initialize, even when
 * no real embedding provider (OpenAI/Gemini/Ollama/…) is configured. Lexical
 * BM25 retrieval does the heavy lifting in the vault; these vectors add a
 * token-overlap signal on top. When this provider is in use, embedding status
 * is reported as `usingHashFallback: true`.
 *
 * @see resolveEmbeddingProvider — returns null when no real provider exists;
 *      callers fall back to this so the vault is never silently skipped.
 */

import type { EmbeddingBatch, IEmbeddingProvider } from "../rag.interface.js";

/** Default bucket count. Small on purpose — a lexical fallback needs no 1.5k dims. */
export const DEFAULT_HASH_EMBEDDING_DIMENSIONS = 256;

export interface HashEmbeddingOptions {
  /** Number of hash buckets (vector dimensionality). Default 256. */
  dimensions?: number;
}

export class HashEmbeddingProvider implements IEmbeddingProvider {
  readonly name = "hash-fallback";
  readonly dimensions: number;

  constructor(options: HashEmbeddingOptions = {}) {
    const dims = options.dimensions ?? DEFAULT_HASH_EMBEDDING_DIMENSIONS;
    // Guard against a zero/negative/NaN dimension that would break the vector math.
    this.dimensions = Number.isInteger(dims) && dims > 0 ? dims : DEFAULT_HASH_EMBEDDING_DIMENSIONS;
  }

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    let totalTokens = 0;
    const embeddings: number[][] = texts.map((text) => {
      const tokens = this.tokenize(text);
      totalTokens += tokens.length;
      return this.hashVector(tokens);
    });
    return { embeddings, usage: { totalTokens }, model: this.name, dimensions: this.dimensions };
  }

  async embedOne(text: string): Promise<number[]> {
    return this.hashVector(this.tokenize(text));
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9_]+/u).filter((t) => t.length > 0);
  }

  /** Signed feature-hashing into `dimensions` buckets, then L2-normalized. */
  private hashVector(tokens: string[]): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const token of tokens) {
      const h = this.hash(token);
      const bucket = h % this.dimensions;
      // Use a high bit for the sign so it is uncorrelated with the low bits that
      // pick the bucket (reduces systematic collision bias).
      const sign = ((h >>> 24) & 1) === 1 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec; // empty / token-less text → zero vector
    for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i]! / norm;
    return vec;
  }

  /** FNV-1a 32-bit hash → unsigned 32-bit int. */
  private hash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}
