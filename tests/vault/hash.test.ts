import { describe, it, expect } from 'vitest';
import { xxhash64Hex, chunkIdFor } from '../../src/vault/hash.js';

describe('vault/hash', () => {
  it('xxhash64Hex is deterministic and 16 hex chars', () => {
    const a = xxhash64Hex('hello');
    const b = xxhash64Hex('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('xxhash64Hex differs for different inputs', () => {
    expect(xxhash64Hex('a')).not.toBe(xxhash64Hex('b'));
  });

  it('chunkIdFor is deterministic and path-sensitive', () => {
    expect(chunkIdFor('path/a.ts', 10, 'body')).toBe(chunkIdFor('path/a.ts', 10, 'body'));
    expect(chunkIdFor('path/a.ts', 10, 'body')).not.toBe(chunkIdFor('path/b.ts', 10, 'body'));
  });
});
