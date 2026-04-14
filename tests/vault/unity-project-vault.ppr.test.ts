import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';

class StubEmb {
  readonly model = 'stub'; readonly dim = 4;
  async embed(t: string[]) { return t.map(() => new Float32Array([1, 0, 0, 0])); }
}
class StubStore {
  private i = 0; private items: Array<{ id: number; payload: unknown }> = [];
  add(_: Float32Array, p: unknown) { const id = ++this.i; this.items.push({ id, payload: p }); return id; }
  remove() {}
  search() { return this.items.map((x) => ({ id: x.id, score: 0.5, payload: x.payload })); }
}

describe('UnityProjectVault — PPR re-rank', () => {
  let dir: string; let vault: UnityProjectVault;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vault-ppr-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    vault = new UnityProjectVault({
      id: 't', rootPath: dir,
      embedding: new StubEmb() as never, vectorStore: new StubStore() as never,
    });
    await vault.init();
  });
  afterEach(async () => { await vault.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('focusFiles boosts chunks from Controller.cs when seeded on Controller', async () => {
    const r = await vault.query({ text: 'move player', topK: 10, focusFiles: ['Assets/Scripts/Controller.cs'] });
    const half = r.hits.slice(0, Math.max(1, Math.ceil(r.hits.length / 2)));
    expect(half.some((h) => h.chunk.path === 'Assets/Scripts/Controller.cs')).toBe(true);
  });

  it('no focusFiles means Phase 1 path still works', async () => {
    const r = await vault.query({ text: 'move player', topK: 10 });
    expect(r.hits.length).toBeGreaterThan(0);
  });
});
