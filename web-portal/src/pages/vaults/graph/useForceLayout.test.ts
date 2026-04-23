import { describe, expect, it } from 'vitest';
import { runForceLayout } from './useForceLayout';

describe('runForceLayout', () => {
  it('returns empty list for empty input', () => {
    expect(runForceLayout([], [])).toEqual([]);
  });

  it('produces one position per input node and respects their ids', () => {
    const nodes = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    const out = runForceLayout(nodes, edges, 20);
    expect(out).toHaveLength(3);
    expect(out.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    for (const p of out) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('ignores edges pointing to non-existent nodes', () => {
    const nodes = [{ id: 'only-one' }];
    const edges = [{ source: 'only-one', target: 'ghost' }];
    // Should not throw even though "ghost" is not in node set.
    const out = runForceLayout(nodes, edges, 5);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('only-one');
  });

  it('is deterministic for the same input shape (same initial seed positions)', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const edges = [{ source: 'a', target: 'b' }];
    const run1 = runForceLayout(nodes, edges, 30);
    const run2 = runForceLayout(nodes, edges, 30);
    expect(run1).toEqual(run2);
  });
});
