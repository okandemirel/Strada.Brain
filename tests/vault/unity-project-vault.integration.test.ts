import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
import type { EmbeddingProvider, VectorStore } from '../../src/vault/embedding-adapter.js';

class Stub implements EmbeddingProvider {
  readonly model = 'stub'; readonly dim = 4;
  async embed(xs: string[]) {
    return xs.map((t) => {
      const v = new Float32Array(4);
      for (let i = 0; i < 4; i++) v[i] = t.charCodeAt(i) ?? 0;
      return v;
    });
  }
}
class InMem implements VectorStore {
  private n = 1; items = new Map<number, unknown>();
  add(_v: Float32Array, p: unknown) { const id = this.n++; this.items.set(id, p); return id; }
  remove(id: number) { this.items.delete(id); }
  search() { return [...this.items.entries()].slice(0, 10).map(([id, payload]) => ({ id, score: 0.9, payload })); }
}

let dir: string;
let vault: UnityProjectVault;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upv-'));
  cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
  vault = new UnityProjectVault({
    id: 'test', rootPath: dir, embedding: new Stub(), vectorStore: new InMem(),
  });
});

afterEach(async () => {
  await vault.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('UnityProjectVault', () => {
  it('init indexes fixture files', async () => {
    await vault.init();
    const stats = await vault.stats();
    expect(stats.fileCount).toBeGreaterThanOrEqual(2);
    expect(stats.chunkCount).toBeGreaterThanOrEqual(2);
  });

  it('query finds chunks by keyword', async () => {
    await vault.init();
    const res = await vault.query({ text: 'Attack', topK: 5 });
    expect(res.hits.some((h) => h.chunk.path.endsWith('Enemy.cs'))).toBe(true);
  });

  it('sync with no changes reports 0 changed', async () => {
    await vault.init();
    const r = await vault.sync();
    expect(r.changed).toBe(0);
  });
});
