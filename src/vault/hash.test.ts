import { describe, expect, it } from 'vitest';
import { chunkIdFor, xxhash64Hex } from './hash.js';

describe('xxhash64Hex', () => {
  it('is deterministic for the same input', () => {
    expect(xxhash64Hex('hello')).toBe(xxhash64Hex('hello'));
  });

  it('returns exactly 16 lowercase hex characters', () => {
    expect(xxhash64Hex('hello')).toMatch(/^[0-9a-f]{16}$/);
    expect(xxhash64Hex('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different inputs', () => {
    expect(xxhash64Hex('hello')).not.toBe(xxhash64Hex('hello!'));
  });

  it('hashes equal string and Buffer inputs identically', () => {
    expect(xxhash64Hex('hello')).toBe(xxhash64Hex(Buffer.from('hello', 'utf8')));
  });
});

describe('chunkIdFor', () => {
  it('returns 32 hex characters', () => {
    expect(chunkIdFor('notes/a.md', 0, '# body')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable across calls', () => {
    expect(chunkIdFor('notes/a.md', 0, '# body')).toBe(chunkIdFor('notes/a.md', 0, '# body'));
  });

  it('differs when path, offset, or body differs', () => {
    const base = chunkIdFor('notes/a.md', 0, '# body');
    expect(chunkIdFor('notes/b.md', 0, '# body')).not.toBe(base);
    expect(chunkIdFor('notes/a.md', 1, '# body')).not.toBe(base);
    expect(chunkIdFor('notes/a.md', 0, '# other')).not.toBe(base);
  });
});
