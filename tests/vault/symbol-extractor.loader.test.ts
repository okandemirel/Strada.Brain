import { describe, it, expect } from 'vitest';
import { loadLanguageParser } from '../../src/vault/symbol-extractor/tree-sitter-loader.js';

describe('tree-sitter-loader', () => {
  it('loads the typescript grammar and parses a trivial source', async () => {
    const parser = await loadLanguageParser('typescript');
    const tree = parser.parse('const x = 1;');
    expect(tree?.rootNode.type).toBe('program');
  }, 20_000);

  it('loads the csharp grammar and parses a trivial source', async () => {
    const parser = await loadLanguageParser('csharp');
    const tree = parser.parse('class A {}');
    expect(tree?.rootNode.type).toBe('compilation_unit');
  }, 20_000);

  it('returns a FRESH parser per call (concurrency safety)', async () => {
    const p1 = await loadLanguageParser('typescript');
    const p2 = await loadLanguageParser('typescript');
    // phase2-review I4: must NOT be shared — sharing corrupts concurrent parses.
    expect(p1).not.toBe(p2);
    // Both should parse independently.
    expect(p1.parse('const a = 1;')?.rootNode.type).toBe('program');
    expect(p2.parse('const b = 2;')?.rootNode.type).toBe('program');
  }, 20_000);
});
