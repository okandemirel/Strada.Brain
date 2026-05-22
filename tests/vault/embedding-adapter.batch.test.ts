import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EmbeddingAdapter,
  EmbeddingBatchMismatchError,
  type EmbeddingProvider,
  type VectorStore,
} from '../../src/vault/embedding-adapter.js';

class CountingProvider implements EmbeddingProvider {
  readonly model = 'count-v1';
  readonly dim = 2;
  calls: number[] = [];
  constructor(private behavior: 'ok' | 'truncate' = 'ok') {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts.length);
    const out: Float32Array[] = [];
    const limit = this.behavior === 'truncate' ? Math.max(0, texts.length - 1) : texts.length;
    for (let i = 0; i < limit; i++) {
      const v = new Float32Array(2);
      v[0] = texts[i]!.length;
      out.push(v);
    }
    return out;
  }
}

class RecordingStore implements VectorStore {
  private next = 1;
  added: Array<{ id: number; payload: unknown }> = [];
  removed: number[] = [];
  add(_v: Float32Array, payload: unknown): number {
    const id = this.next++;
    this.added.push({ id, payload });
    return id;
  }
  remove(id: number): void {
    this.removed.push(id);
  }
  search(): Array<{ id: number; score: number; payload?: unknown }> {
    return [];
  }
  clear(): void {
    this.added = [];
  }
}

function makeChunks(n: number) {
  return Array.from({ length: n }, (_, i) => ({ chunkId: `c${i}`, content: `text-${i}` }));
}

describe('EmbeddingAdapter sub-batching', () => {
  const originalEnv = process.env.VAULT_EMBED_BATCH_SIZE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VAULT_EMBED_BATCH_SIZE;
    else process.env.VAULT_EMBED_BATCH_SIZE = originalEnv;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    delete process.env.VAULT_EMBED_BATCH_SIZE;
  });

  it('splits a large input into multiple provider.embed() calls', async () => {
    const provider = new CountingProvider('ok');
    const store = new RecordingStore();
    const adapter = new EmbeddingAdapter(provider, store, { batchSize: 4 });
    const ids = await adapter.upsertBatch(makeChunks(10));
    expect(Object.keys(ids)).toHaveLength(10);
    expect(provider.calls).toEqual([4, 4, 2]);
    expect(store.added).toHaveLength(10);
  });

  it('honours VAULT_EMBED_BATCH_SIZE when no explicit batchSize is given', async () => {
    process.env.VAULT_EMBED_BATCH_SIZE = '3';
    const provider = new CountingProvider('ok');
    const store = new RecordingStore();
    const adapter = new EmbeddingAdapter(provider, store);
    await adapter.upsertBatch(makeChunks(7));
    expect(provider.calls).toEqual([3, 3, 1]);
  });

  it('throws EmbeddingBatchMismatchError when provider returns fewer vectors than inputs', async () => {
    const provider = new CountingProvider('truncate');
    const store = new RecordingStore();
    const adapter = new EmbeddingAdapter(provider, store, { batchSize: 5 });
    await expect(adapter.upsertBatch(makeChunks(5))).rejects.toBeInstanceOf(
      EmbeddingBatchMismatchError,
    );
    // No partial HNSW upserts should remain — adapter verifies all sub-batches
    // before committing any vectors to the store.
    expect(store.added).toHaveLength(0);
  });

  it('does not commit earlier batches when a later sub-batch mismatches', async () => {
    // Provider returns full count on the first call, truncates the second.
    let call = 0;
    const provider: EmbeddingProvider = {
      model: 'mix',
      dim: 2,
      async embed(texts: string[]) {
        call++;
        const limit = call === 2 ? texts.length - 1 : texts.length;
        return Array.from({ length: limit }, () => new Float32Array(2));
      },
    };
    const store = new RecordingStore();
    const adapter = new EmbeddingAdapter(provider, store, { batchSize: 3 });
    await expect(adapter.upsertBatch(makeChunks(6))).rejects.toBeInstanceOf(
      EmbeddingBatchMismatchError,
    );
    expect(store.added).toHaveLength(0);
  });

  it('returns an empty map for an empty input without calling the provider', async () => {
    const provider = new CountingProvider('ok');
    const store = new RecordingStore();
    const adapter = new EmbeddingAdapter(provider, store);
    const out = await adapter.upsertBatch([]);
    expect(out).toEqual({});
    expect(provider.calls).toEqual([]);
  });
});
