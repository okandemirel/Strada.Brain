import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import { buildProjectContext } from '../../src/agents/context/strada-knowledge.js';
import type { EmbeddingProvider, VectorStore } from '../../src/vault/embedding-adapter.js';

class Stub implements EmbeddingProvider {
  readonly model = 'stub'; readonly dim = 4;
  async embed(xs: string[]) { return xs.map(() => new Float32Array(4)); }
}
class Mem implements VectorStore {
  private n = 1; items = new Map<number, unknown>();
  add(_v: Float32Array, p: unknown) { const id = this.n++; this.items.set(id, p); return id; }
  remove(id: number) { this.items.delete(id); }
  search() { return [...this.items.entries()].slice(0, 10).map(([id, payload]) => ({ id, score: 0.8, payload })); }
}

let dir: string;
let reg: VaultRegistry;
let vault: UnityProjectVault;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'accept-'));
  cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
  reg = new VaultRegistry();
  vault = new UnityProjectVault({ id: 'unity:t', rootPath: dir, embedding: new Stub(), vectorStore: new Mem() });
  await vault.init();
  reg.register(vault);
});

afterEach(async () => {
  await reg.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('Phase 1 acceptance', () => {
  it('buildProjectContext (flag on) returns vault-backed results', async () => {
    const r = await buildProjectContext({
      config: { vault: { enabled: true } },
      vaultRegistry: reg,
      userMessage: 'Player Move',
      recentlyTouched: [],
      contextBudget: 2000,
    } as any);
    expect(r).toContain('Player.cs');
  });

  it('buildProjectContext (flag off) uses legacy', async () => {
    const r = await buildProjectContext({
      config: { vault: { enabled: false } },
      vaultRegistry: reg,
      userMessage: 'q',
      contextBudget: 100,
      legacyBuildProjectContext: async () => 'LEGACY',
    } as any);
    expect(r).toBe('LEGACY');
  });

  it('a file added after startWatch is picked up', async () => {
    await vault.startWatch(150);
    writeFileSync(join(dir, 'Assets/Scripts/Boss.cs'), 'namespace Game { public class Boss : MonoBehaviour { public void Roar() {} } }');
    await new Promise((r) => setTimeout(r, 1500));
    const r = await buildProjectContext({
      config: { vault: { enabled: true } },
      vaultRegistry: reg,
      userMessage: 'Boss',
      contextBudget: 2000,
    } as any);
    expect(r).toContain('Boss');
    await vault.stopWatch();
  });
});
