import { describe, it, expect } from 'vitest';
import { buildCanvas } from '../../src/vault/canvas-generator.js';
import type { VaultSymbol, VaultEdge } from '../../src/vault/vault.interface.js';

describe('buildCanvas', () => {
  it('emits JSON Canvas 1.0 with a node per top-level symbol and an edge per call', () => {
    const symbols: VaultSymbol[] = [
      { symbolId: 'a', path: 'a.ts', kind: 'class', name: 'A', display: 'A', startLine: 1, endLine: 2, doc: null },
      { symbolId: 'b', path: 'b.ts', kind: 'class', name: 'B', display: 'B', startLine: 1, endLine: 2, doc: null },
    ];
    const edges: VaultEdge[] = [
      { fromSymbol: 'a', toSymbol: 'b', kind: 'calls', atLine: 1 },
    ];
    const canvas = buildCanvas({ symbols, edges });
    expect(canvas.nodes).toHaveLength(2);
    expect(canvas.edges).toHaveLength(1);
    const n = canvas.nodes[0]!;
    expect(typeof n.id).toBe('string');
    expect(typeof n.x).toBe('number');
    expect(typeof n.y).toBe('number');
    expect(typeof n.width).toBe('number');
    expect(typeof n.height).toBe('number');
    expect(n.type).toBe('text');
    expect(canvas.edges[0]!.fromNode).toBe('a');
    expect(canvas.edges[0]!.toNode).toBe('b');
  });

  it('skips edges whose endpoints are missing (unresolved externs)', () => {
    const canvas = buildCanvas({
      symbols: [{ symbolId: 'a', path: 'a.ts', kind: 'class', name: 'A', display: 'A', startLine: 1, endLine: 2, doc: null }],
      edges: [{ fromSymbol: 'a', toSymbol: 'csharp::unresolved::Foo', kind: 'calls', atLine: 1 }],
    });
    expect(canvas.edges).toHaveLength(0);
  });
});
