import { describe, it, expect } from 'vitest';
import { chunkFile } from '../../src/vault/chunker.js';

describe('chunker', () => {
  it('splits markdown by H2 headings', () => {
    const md = `# Title\n\npara\n\n## Section A\n\naaa\n\n## Section B\n\nbbb`;
    const chunks = chunkFile({ path: 'doc.md', content: md, lang: 'markdown' });
    expect(chunks.length).toBe(3);
    expect(chunks[1].content).toContain('Section A');
  });

  it('falls back to fixed windows for code', () => {
    const code = Array.from({ length: 500 }, (_, i) => `int x${i} = ${i};`).join('\n');
    const chunks = chunkFile({ path: 'a.cs', content: code, lang: 'csharp' });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('produces deterministic IDs', () => {
    const a = chunkFile({ path: 'x.md', content: '# A\n\npara', lang: 'markdown' });
    const b = chunkFile({ path: 'x.md', content: '# A\n\npara', lang: 'markdown' });
    expect(a[0].chunkId).toBe(b[0].chunkId);
  });

  it('hard-splits a single line longer than MAX_CHARS', () => {
    const longLine = 'x'.repeat(2500);
    const chunks = chunkFile({ path: 'huge.cs', content: longLine, lang: 'csharp' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1600);
    }
  });

  it('handles CRLF line endings consistently across markdown and code paths', () => {
    const code = 'a = 1;\r\nb = 2;\r\nc = 3;';
    const chunks = chunkFile({ path: 'a.cs', content: code, lang: 'csharp' });
    for (const c of chunks) {
      expect(c.content).not.toMatch(/\r/);
    }
  });
});
