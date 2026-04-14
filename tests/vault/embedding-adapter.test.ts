import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from '../../src/vault/embedding-adapter.js';

class FakeProvider implements EmbeddingProvider {
  readonly model = 'fake-v1'; readonly dim = 4;
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Float32Array(4);
      v[0] = t.length;
      v[1] = t.charCodeAt(0) ?? 0;
      return v;
    });
  }
}

class FakeStore implements VectorStore {
  private next = 1;
  readonly items = new Map<number, { v: Float32Array; payload: unknown }>();
  add(v: Float32Array, payload: unknown) { const id = this.next++; this.items.set(id, { v, payload }); return id; }
  remove(id: number) { this.items.delete(id); }
  search(_v: Float32Array, k: number) {
    return [...this.items.entries()].slice(0, k).map(([id, rec]) => ({ id, score: 0.9, payload: rec.payload }));
  }
}

describe('EmbeddingAdapter', () => {
  let adapter: EmbeddingAdapter;
  let store: FakeStore;
  beforeEach(() => { store = new FakeStore(); adapter = new EmbeddingAdapter(new FakeProvider(), store); });

  it('upsertBatch embeds and returns hnsw ids', async () => {
    const ids = await adapter.upsertBatch([
      { chunkId: 'c1', content: 'alpha' },
      { chunkId: 'c2', content: 'beta' },
    ]);
    expect(ids).toEqual({ c1: 1, c2: 2 });
    expect(store.items.size).toBe(2);
  });

  it('remove deletes from vector store', async () => {
    await adapter.upsertBatch([{ chunkId: 'c1', content: 'alpha' }]);
    adapter.remove(1);
    expect(store.items.size).toBe(0);
  });

  it('search returns hits with chunkId payload preserved', async () => {
    await adapter.upsertBatch([{ chunkId: 'c1', content: 'alpha' }]);
    const hits = await adapter.search('alpha', 5);
    expect(hits[0].payload).toMatchObject({ chunkId: 'c1' });
  });
});
