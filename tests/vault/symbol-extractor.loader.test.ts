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

  it('caches parsers across calls', async () => {
    const p1 = await loadLanguageParser('typescript');
    const p2 = await loadLanguageParser('typescript');
    expect(p1).toBe(p2);
  });
});
