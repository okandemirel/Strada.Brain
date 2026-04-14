import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
import { buildCanvas } from '../../src/vault/canvas-generator.js';

class StubEmb {
  readonly model = 'stub'; readonly dim = 4;
  async embed(t: string[]) { return t.map(() => new Float32Array([1, 0, 0, 0])); }
}
class StubStore {
  private i = 0; private items: Array<{ id: number; payload: unknown }> = [];
  add(_: Float32Array, p: unknown) { const id = ++this.i; this.items.push({ id, payload: p }); return id; }
  remove() {}
  search() { return this.items.slice(0, 10).map((x) => ({ id: x.id, score: 0.5, payload: x.payload })); }
}

describe('Phase 2 acceptance', () => {
  let dir: string; let vault: UnityProjectVault;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'phase2-accept-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    vault = new UnityProjectVault({
      id: 'a', rootPath: dir,
      embedding: new StubEmb() as never, vectorStore: new StubStore() as never,
    });
    await vault.init();
  });
  afterEach(async () => { await vault.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('find callers of Player.Move returns Controller.Update', async () => {
    const callers = await vault.findCallers!('csharp::Assets/Scripts/Player.cs::Game.Player.Move');
    expect(callers.some((e) => e.fromSymbol.includes('Controller.Update'))).toBe(true);
  });

  it('graph.canvas is valid JSON Canvas 1.0 with Player + Controller nodes', () => {
    const raw = readFileSync(join(dir, '.strada/vault/graph.canvas'), 'utf8');
    const canvas = JSON.parse(raw);
    expect(Array.isArray(canvas.nodes) && Array.isArray(canvas.edges)).toBe(true);
    const ids = canvas.nodes.map((n: { id: string }) => n.id);
    expect(ids.some((i: string) => i.includes('Game.Player'))).toBe(true);
    expect(ids.some((i: string) => i.includes('Game.Controller'))).toBe(true);
  });

  it('buildCanvas on 1000 synthetic nodes runs under 1000 ms', () => {
    const symbols = Array.from({ length: 1000 }, (_, i) => ({
      symbolId: `s${i}`, path: `f${i % 50}.ts`, kind: 'class' as const,
      name: `S${i}`, display: `S${i}`, startLine: 1, endLine: 1, doc: null,
    }));
    const edges = Array.from({ length: 2000 }, (_, i) => ({
      fromSymbol: `s${i % 1000}`, toSymbol: `s${(i + 1) % 1000}`, kind: 'calls' as const, atLine: 1,
    }));
    const t0 = performance.now();
    const canvas = buildCanvas({ symbols, edges });
    const ms = performance.now() - t0;
    expect(canvas.nodes).toHaveLength(1000);
    expect(ms).toBeLessThan(1000);
  });
});
