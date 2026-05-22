import { getLoggerSafe } from '../utils/logger.js';
import { parsePositiveIntEnv } from './env-helpers.js';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface VectorStore {
  add(vector: Float32Array, payload: unknown): number;
  remove(id: number): void;
  search(vector: Float32Array, k: number): Array<{ id: number; score: number; payload?: unknown }>;
  clear(): void;
}

export interface ChunkToEmbed {
  chunkId: string;
  content: string;
}

/**
 * Thrown when an embedding provider returns a vector count that does not match
 * the input text count for a sub-batch. Indicates a provider contract violation
 * or upstream truncation (e.g. exceeding a provider-side batch limit).
 */
export class EmbeddingBatchMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly batchIndex: number,
    readonly batchTotal: number,
  ) {
    super(
      `EmbeddingProvider contract violation: got ${actual} vectors for ${expected} chunks ` +
        `(sub-batch ${batchIndex + 1}/${batchTotal})`,
    );
    this.name = 'EmbeddingBatchMismatchError';
  }
}

const DEFAULT_EMBEDDING_BATCH_SIZE = 256;
/** Soft warning threshold (in bytes) for the in-memory vector buffer used by upsertBatch. */
const VECTOR_BUFFER_WARN_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Resolves the effective sub-batch size used to chunk calls to the embedding
 * provider. Order of precedence:
 *   1. explicit constructor option
 *   2. VAULT_EMBED_BATCH_SIZE environment variable
 *   3. DEFAULT_EMBEDDING_BATCH_SIZE
 *
 * Invalid / non-positive values fall back to the default so a malformed env
 * never disables batching silently.
 */
function resolveBatchSize(explicit: number | undefined): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return parsePositiveIntEnv('VAULT_EMBED_BATCH_SIZE', DEFAULT_EMBEDDING_BATCH_SIZE);
}

export interface EmbeddingAdapterOptions {
  /** Override the per-call batch size sent to the embedding provider. */
  batchSize?: number;
}

export class EmbeddingAdapter {
  private readonly batchSize: number;

  constructor(
    readonly provider: EmbeddingProvider,
    readonly store: VectorStore,
    opts: EmbeddingAdapterOptions = {},
  ) {
    this.batchSize = resolveBatchSize(opts.batchSize);
  }

  /**
   * Embed and upsert a batch of chunks into the vector store.
   *
   * Memory profile: this implementation buffers every embedded vector before
   * touching the vector store so a mid-stream provider mismatch cannot leave
   * partial HNSW upserts behind (atomicity > peak memory). Peak memory is
   * approximately `chunks.length * provider.dim * 4` bytes. For the default
   * batch size (256) and 1536-dim vectors this is ~1.5 MB. At
   * VAULT_EMBED_BATCH_SIZE=2048 with high-dim providers it can exceed 50 MB
   * — at that point we emit a warn log. If you need a strictly bounded
   * memory footprint, lower `batchSize`; a streaming mode is intentionally
   * not exposed here because it sacrifices atomicity.
   */
  async upsertBatch(chunks: ChunkToEmbed[]): Promise<Record<string, number>> {
    if (chunks.length === 0) return {};
    const batchSize = this.batchSize;
    const batchTotal = Math.ceil(chunks.length / batchSize);

    // Memory-peak guard: warn (don't fail) when the buffered vectors would
    // cross the soft threshold. This catches operator misconfigurations
    // (huge batch + huge dim) early without breaking legitimate big runs.
    const estimatedPeakBytes = chunks.length * this.provider.dim * 4;
    if (estimatedPeakBytes > VECTOR_BUFFER_WARN_BYTES) {
      getLoggerSafe().warn('[EmbeddingAdapter] vector buffer estimate exceeds soft limit', {
        op: 'embed-batch-memory',
        estimatedPeakBytes,
        softLimitBytes: VECTOR_BUFFER_WARN_BYTES,
        chunkCount: chunks.length,
        dim: this.provider.dim,
        batchSize,
        hint: 'lower VAULT_EMBED_BATCH_SIZE or reduce the upstream chunk count to bound memory',
      });
    }

    // Single pass: walk sub-batches once, embed → verify → push to a buffered
    // list of (chunkId, vector) tuples. We still defer store.add() to a
    // second loop so a late mismatch aborts before any HNSW mutation.
    const pending: Array<{ chunkId: string; vector: Float32Array }> = [];
    for (let batchIndex = 0; batchIndex < batchTotal; batchIndex++) {
      const start = batchIndex * batchSize;
      const slice = chunks.slice(start, start + batchSize);
      const vectors = await this.provider.embed(slice.map((c) => c.content));
      getLoggerSafe().debug('[EmbeddingAdapter] embed sub-batch', {
        op: 'embed-batch',
        chunkCount: slice.length,
        batchIndex,
        batchTotal,
      });
      if (vectors.length !== slice.length) {
        throw new EmbeddingBatchMismatchError(slice.length, vectors.length, batchIndex, batchTotal);
      }
      for (let i = 0; i < slice.length; i++) {
        pending.push({ chunkId: slice[i]!.chunkId, vector: vectors[i]! });
      }
    }

    // Commit phase: every sub-batch verified, push vectors into the store.
    const out: Record<string, number> = {};
    for (const { chunkId, vector } of pending) {
      const id = this.store.add(vector, { chunkId });
      out[chunkId] = id;
    }
    return out;
  }

  remove(hnswId: number): void {
    this.store.remove(hnswId);
  }

  async search(query: string, topK: number): Promise<Array<{ id: number; score: number; payload?: unknown }>> {
    const [vec] = await this.provider.embed([query]);
    return this.store.search(vec!, topK);
  }
}
