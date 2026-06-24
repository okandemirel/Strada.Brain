import { describe, expect, it, vi } from 'vitest';
import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from './embedding-adapter.js';

vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeProvider(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    model: 'fake',
    dim: 3,
    embed: async (texts) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    ...overrides,
  };
}

function makeStore(opts: { semantic?: boolean } = {}): VectorStore & { searchCalls: number } {
  let next = 1;
  const items = new Map<number, unknown>();
  return {
    semantic: opts.semantic,
    searchCalls: 0,
    add(_v, payload) { const id = next++; items.set(id, payload); return id; },
    remove(id) { items.delete(id); },
    search(_v, k) {
      this.searchCalls++;
      return [...items.entries()].slice(0, k).map(([id, payload]) => ({ id, score: 1, payload }));
    },
    clear() { items.clear(); next = 1; },
  };
}

describe('EmbeddingAdapter.isSemantic', () => {
  it('is false when the store omits the semantic flag', () => {
    const adapter = new EmbeddingAdapter(makeProvider(), makeStore());
    expect(adapter.isSemantic()).toBe(false);
  });

  it('is false when the store sets semantic:false', () => {
    const adapter = new EmbeddingAdapter(makeProvider(), makeStore({ semantic: false }));
    expect(adapter.isSemantic()).toBe(false);
  });

  it('is true only when the store sets semantic:true', () => {
    const adapter = new EmbeddingAdapter(makeProvider(), makeStore({ semantic: true }));
    expect(adapter.isSemantic()).toBe(true);
  });
});

describe('EmbeddingAdapter.search (best-effort, A.1)', () => {
  it('returns [] (does not throw) when the embedding provider throws', async () => {
    const provider = makeProvider({ embed: async () => { throw new Error('provider down'); } });
    const store = makeStore({ semantic: true });
    const adapter = new EmbeddingAdapter(provider, store);

    await expect(adapter.search('query', 5)).resolves.toEqual([]);
    // The provider threw before the store was consulted.
    expect(store.searchCalls).toBe(0);
  });

  it('returns [] when the provider yields no vector for the query', async () => {
    const provider = makeProvider({ embed: async () => [] }); // contract violation → no vec
    const store = makeStore({ semantic: true });
    const adapter = new EmbeddingAdapter(provider, store);

    await expect(adapter.search('query', 5)).resolves.toEqual([]);
    expect(store.searchCalls).toBe(0);
  });

  it('delegates to the store when the provider returns a vector', async () => {
    const provider = makeProvider();
    const store = makeStore({ semantic: true });
    const adapter = new EmbeddingAdapter(provider, store);
    adapter.store.add(new Float32Array([0.1, 0.2, 0.3]), { chunkId: 'c1' });

    const out = await adapter.search('query', 5);
    expect(store.searchCalls).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ payload: { chunkId: 'c1' } });
  });
});
