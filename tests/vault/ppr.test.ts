import { describe, it, expect } from 'vitest';
import { runPpr } from '../../src/vault/ppr.js';

describe('runPpr', () => {
  it('single-seed converges, seed dominates', () => {
    const edges = [
      { fromSymbol: 'a', toSymbol: 'b', kind: 'calls' as const, atLine: 0 },
      { fromSymbol: 'b', toSymbol: 'c', kind: 'calls' as const, atLine: 0 },
      { fromSymbol: 'c', toSymbol: 'a', kind: 'calls' as const, atLine: 0 },
    ];
    const scores = runPpr(edges, ['a'], { damping: 0.15, iterations: 30, epsilon: 1e-6 });
    expect(scores.get('a')).toBeGreaterThan(scores.get('b') ?? 0);
    expect(scores.get('a')).toBeGreaterThan(scores.get('c') ?? 0);
    const sum = [...scores.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  it('returns empty map if no seed matches any symbol', () => {
    const scores = runPpr([], ['nonexistent']);
    expect(scores.size).toBe(0);
  });

  it('handles disconnected subgraphs without blowing up', () => {
    const edges = [
      { fromSymbol: 'a', toSymbol: 'b', kind: 'calls' as const, atLine: 0 },
      { fromSymbol: 'x', toSymbol: 'y', kind: 'calls' as const, atLine: 0 },
    ];
    const scores = runPpr(edges, ['a']);
    expect((scores.get('a') ?? 0) + (scores.get('b') ?? 0)).toBeGreaterThan(0.99);
  });
});
