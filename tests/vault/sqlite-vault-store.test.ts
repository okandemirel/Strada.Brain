import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVaultStore } from '../../src/vault/sqlite-vault-store.js';

let dir: string;
let store: SqliteVaultStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-store-'));
  store = new SqliteVaultStore(join(dir, 'index.db'));
  store.migrate();
});

describe('SqliteVaultStore', () => {
  it('upsertFile + getFile round-trips', () => {
    store.upsertFile({
      path: 'Assets/Player.cs', blobHash: 'abc0123456789abc', mtimeMs: 1e9,
      size: 512, lang: 'csharp', kind: 'source', indexedAt: 1e9,
    });
    const row = store.getFile('Assets/Player.cs');
    expect(row?.lang).toBe('csharp');
  });

  it('deleteFile cascades to chunks', () => {
    store.upsertFile({ path: 'A.cs', blobHash: 'h', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
    store.upsertChunk({ chunkId: 'c1', path: 'A.cs', startLine: 1, endLine: 10, content: 'hello', tokenCount: 3 });
    store.deleteFile('A.cs');
    expect(store.getFile('A.cs')).toBeNull();
    expect(store.getChunk('c1')).toBeNull();
  });

  it('listFiles filters by lang', () => {
    store.upsertFile({ path: 'a.cs', blobHash: '1', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
    store.upsertFile({ path: 'b.ts', blobHash: '2', mtimeMs: 0, size: 1, lang: 'typescript', kind: 'source', indexedAt: 0 });
    const cs = store.listFiles({ lang: ['csharp'] });
    expect(cs).toHaveLength(1);
  });

  it('searchFts returns BM25 hits', () => {
    store.upsertFile({ path: 'A.cs', blobHash: 'h', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
    store.upsertChunk({ chunkId: 'c1', path: 'A.cs', startLine: 1, endLine: 2, content: 'player jumps high', tokenCount: 3 });
    store.upsertChunk({ chunkId: 'c2', path: 'A.cs', startLine: 3, endLine: 4, content: 'enemy attacks player', tokenCount: 3 });
    const hits = store.searchFts('player', 10);
    expect(hits.map(h => h.chunkId).sort()).toEqual(['c1', 'c2']);
  });

  it('chunkCount reports current total', () => {
    store.upsertFile({ path: 'A.cs', blobHash: 'h', mtimeMs: 0, size: 1, lang: 'csharp', kind: 'source', indexedAt: 0 });
    store.upsertChunk({ chunkId: 'c1', path: 'A.cs', startLine: 1, endLine: 2, content: 'x', tokenCount: 1 });
    store.upsertChunk({ chunkId: 'c2', path: 'A.cs', startLine: 3, endLine: 4, content: 'y', tokenCount: 1 });
    expect(store.chunkCount()).toBe(2);
  });

  it('migrate is idempotent (safe to call twice)', () => {
    // Already called once in beforeEach; calling again must not throw.
    expect(() => store.migrate()).not.toThrow();
  });
});
