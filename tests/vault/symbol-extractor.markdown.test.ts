import { describe, it, expect } from 'vitest';
import { MarkdownSymbolExtractor } from '../../src/vault/symbol-extractor/markdown-extractor.js';
import { getExtractorFor } from '../../src/vault/symbol-extractor/index.js';

describe('MarkdownSymbolExtractor', () => {
  it('creates a note symbol + extracts wikilinks', async () => {
    const x = new MarkdownSymbolExtractor();
    const out = await x.extract({
      path: 'decisions/a.md',
      content: '# Heading\n\nSee [[target]] and [[other.md]].',
      lang: 'markdown',
    });
    expect(out.symbols).toHaveLength(1);
    expect(out.symbols[0]!.kind).toBe('note');
    expect(out.wikilinks.map((w) => w.target).sort()).toEqual(['other.md', 'target']);
    expect(out.wikilinks.every((w) => w.resolved === false)).toBe(true);
  });

  it('ignores code-fenced wikilinks', async () => {
    const x = new MarkdownSymbolExtractor();
    const out = await x.extract({
      path: 'a.md',
      content: 'outside [[real]]\n```\n[[fake]]\n```',
      lang: 'markdown',
    });
    expect(out.wikilinks.map((w) => w.target)).toEqual(['real']);
  });
});

describe('getExtractorFor', () => {
  it('returns the right extractor per language', () => {
    expect(getExtractorFor('typescript')).not.toBeNull();
    expect(getExtractorFor('csharp')).not.toBeNull();
    expect(getExtractorFor('markdown')).not.toBeNull();
    expect(getExtractorFor('json')).toBeNull();
  });
});
