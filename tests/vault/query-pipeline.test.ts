import { describe, it, expect } from 'vitest';
import { rrfFuse, packByBudget } from '../../src/vault/query-pipeline.js';

describe('rrfFuse', () => {
  it('combines two ranked lists with RRF', () => {
    const fts = [{ chunkId: 'a', score: 10 }, { chunkId: 'b', score: 5 }];
    const hnsw = [{ chunkId: 'b', score: 0.9 }, { chunkId: 'c', score: 0.7 }];
    const fused = rrfFuse(fts, hnsw, 60);
    expect(fused[0].chunkId).toBe('b');
    expect(fused.length).toBe(3);
  });
  it('handles empty inputs', () => { expect(rrfFuse([], [], 60)).toEqual([]); });
});

describe('packByBudget', () => {
  it('greedily picks chunks up to budget', () => {
    const items = [
      { chunkId: 'a', tokenCount: 100 },
      { chunkId: 'b', tokenCount: 200 },
      { chunkId: 'c', tokenCount: 50 },
    ];
    const { kept, dropped } = packByBudget(items, 180);
    expect(kept.map((x) => x.chunkId)).toEqual(['a', 'c']);
    expect(dropped.map((x) => x.chunkId)).toEqual(['b']);
  });
});
