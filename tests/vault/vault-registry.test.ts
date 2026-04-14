import { describe, it, expect, beforeEach } from 'vitest';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import type { IVault, VaultQuery, VaultQueryResult, VaultStats, VaultFile } from '../../src/vault/vault.interface.js';

class FakeVault implements IVault {
  readonly kind = 'unity-project' as const;
  readonly rootPath = '/tmp';
  constructor(readonly id: string, private result: VaultQueryResult) {}
  async init() {}
  async sync() { return { changed: 0, durationMs: 0 }; }
  async rebuild() {}
  async query(_q: VaultQuery) { return this.result; }
  async stats(): Promise<VaultStats> { return { fileCount: 1, chunkCount: 1, lastIndexedAt: 0, dbBytes: 0 }; }
  async dispose() {}
  listFiles(): VaultFile[] { return []; }
  async readFile() { return ''; }
  onUpdate() { return () => {}; }
}

describe('VaultRegistry', () => {
  let reg: VaultRegistry;
  beforeEach(() => { reg = new VaultRegistry(); });

  it('registers and lists vaults', () => {
    reg.register(new FakeVault('a', { hits: [], budgetUsed: 0, truncated: false }));
    reg.register(new FakeVault('b', { hits: [], budgetUsed: 0, truncated: false }));
    expect(reg.list().map((v) => v.id).sort()).toEqual(['a', 'b']);
  });

  it('query fans out and sorts by RRF', async () => {
    reg.register(new FakeVault('a', {
      hits: [{ chunk: { chunkId: 'x', path: 'p', startLine: 1, endLine: 1, content: '', tokenCount: 0 }, scores: { fts: 1, hnsw: null, rrf: 0.05 } }],
      budgetUsed: 0, truncated: false,
    }));
    reg.register(new FakeVault('b', {
      hits: [{ chunk: { chunkId: 'y', path: 'q', startLine: 1, endLine: 1, content: '', tokenCount: 0 }, scores: { fts: null, hnsw: 0.9, rrf: 0.1 } }],
      budgetUsed: 0, truncated: false,
    }));
    const r = await reg.query({ text: 'foo' });
    expect(r.hits[0].chunk.chunkId).toBe('y');
  });

  it('disposeAll closes everything', async () => {
    let count = 0;
    class Spy extends FakeVault { async dispose() { count++; } }
    reg.register(new Spy('a', { hits: [], budgetUsed: 0, truncated: false }));
    reg.register(new Spy('b', { hits: [], budgetUsed: 0, truncated: false }));
    await reg.disposeAll();
    expect(count).toBe(2);
  });
});
