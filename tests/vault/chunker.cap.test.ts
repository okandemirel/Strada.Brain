import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { chunkFile } from '../../src/vault/chunker.js';

const ORIGINAL_ENV = process.env.VAULT_MAX_CHUNKS_PER_FILE;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.VAULT_MAX_CHUNKS_PER_FILE;
  else process.env.VAULT_MAX_CHUNKS_PER_FILE = ORIGINAL_ENV;
});
beforeEach(() => {
  delete process.env.VAULT_MAX_CHUNKS_PER_FILE;
});

describe('chunker per-file cap', () => {
  it('caps a pathological large file to MAX_CHUNKS_PER_FILE (default 200)', () => {
    // Minified-JSON-like payload: a single line that explodes into many
    // hard-split chunks. ~2MB of single-char tokens reliably exceeds the
    // default 200-chunk cap.
    const content = 'x'.repeat(2 * 1024 * 1024); // 2MB single line
    const chunks = chunkFile({ path: 'huge.json', content, lang: 'json' });
    expect(chunks).toHaveLength(200);
  });

  it('respects VAULT_MAX_CHUNKS_PER_FILE override', () => {
    process.env.VAULT_MAX_CHUNKS_PER_FILE = '10';
    const content = 'x'.repeat(2 * 1024 * 1024);
    const chunks = chunkFile({ path: 'huge.json', content, lang: 'json' });
    expect(chunks).toHaveLength(10);
  });

  it('does not affect small files', () => {
    const code = Array.from({ length: 5 }, (_, i) => `int x${i} = ${i};`).join('\n');
    const chunks = chunkFile({ path: 'tiny.cs', content: code, lang: 'csharp' });
    expect(chunks.length).toBeLessThan(10);
  });
});
