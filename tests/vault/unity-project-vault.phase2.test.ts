import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';

class StubEmb {
  readonly model = 'stub'; readonly dim = 4;
  async embed(texts: string[]) { return texts.map(() => new Float32Array([1, 0, 0, 0])); }
}
class StubStore {
  private i = 0; private items: Array<{ id: number; vec: Float32Array; payload: unknown }> = [];
  add(v: Float32Array, p: unknown) { const id = ++this.i; this.items.push({ id, vec: v, payload: p }); return id; }
  remove() {}
  search() { return this.items.slice(0, 5).map((x) => ({ id: x.id, score: 1, payload: x.payload })); }
}

describe('UnityProjectVault — Phase 2 wiring', () => {
  let dir: string;
  let vault: UnityProjectVault;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vault-upv-p2-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    vault = new UnityProjectVault({
      id: 'test', rootPath: dir, embedding: new StubEmb() as never, vectorStore: new StubStore() as never,
    });
    await vault.init();
  });

  afterEach(async () => { await vault.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('populates vault_symbols for Player.cs after init', async () => {
    const syms = vault.listSymbolsForTest('Assets/Scripts/Player.cs');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Player');
    expect(names).toContain('Move');
  });

  it('findCallers resolves Controller → Player.Move by name tail', async () => {
    const callers = await vault.findCallers!('csharp::Assets/Scripts/Player.cs::Game.Player.Move');
    expect(callers.some((e) => e.fromSymbol.includes('Controller'))).toBe(true);
  });

  it('writes graph.canvas containing at least one node per file', async () => {
    const p = join(dir, '.strada/vault/graph.canvas');
    const raw = readFileSync(p, 'utf8');
    const canvas = JSON.parse(raw);
    expect(Array.isArray(canvas.nodes)).toBe(true);
    const files = new Set(canvas.nodes.map((n: { file?: string }) => n.file));
    expect(files.has('Assets/Scripts/Player.cs')).toBe(true);
  });
});
