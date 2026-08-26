import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
  // Stands in for a REAL semantic (HNSW) backend: returns scored vector hits and
  // is exercised through the RRF-fusion path, so it must declare semantic:true
  // (the vault's query() only calls adapter.search on a semantic store).
  readonly semantic = true;
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

  it('query finds chunks by keyword via FTS', async () => {
    await vault.init();
    const res = await vault.query({ text: 'Attack', topK: 5 });
    const enemyHit = res.hits.find((h) => h.chunk.path.endsWith('Enemy.cs'));
    expect(enemyHit).toBeDefined();
    // Must come via FTS, not just because the stub HNSW returned all items
    expect(enemyHit!.scores.fts).not.toBeNull();
  });

  it('query respects langFilter', async () => {
    await vault.init();
    const res = await vault.query({ text: 'Attack', topK: 10, langFilter: ['markdown'] });
    // Fixture has NO markdown files → result must be empty
    expect(res.hits).toHaveLength(0);
  });

  it('query sets truncated=true when budget drops results', async () => {
    await vault.init();
    // Budget of 1 token will drop all real chunks (each chunk has many tokens).
    const res = await vault.query({ text: 'attack OR move OR player', topK: 10, budgetTokens: 1 });
    expect(res.truncated).toBe(true);
  });

  it('sync with no changes reports 0 changed', async () => {
    await vault.init();
    const r = await vault.sync();
    expect(r.changed).toBe(0);
  });

  it('init reconciles files deleted while the vault was offline', async () => {
    await vault.init();
    unlinkSync(join(dir, 'Assets/Scripts/Enemy.cs'));

    await vault.init();

    expect(vault.listFiles().map((f) => f.path)).not.toContain('Assets/Scripts/Enemy.cs');
  });

  it('init skips the full re-index while a watcher maintains freshness', async () => {
    // Repeated vault_init on a running vault used to re-walk the entire tree
    // per call — a full disk pass each time on days-long autonomous runs.
    await vault.init();
    await vault.startWatch(150);
    const fullIndex = vi.spyOn(vault as unknown as { fullIndex: () => Promise<void> }, 'fullIndex');
    await vault.init();
    await vault.stopWatch();
    expect(fullIndex).not.toHaveBeenCalled();
  });

  it('reindexes files added after startWatch', async () => {
    await vault.init();
    await vault.startWatch(150);
    writeFileSync(join(dir, 'Assets/Scripts/Boss.cs'), 'namespace Game { public class Boss : MonoBehaviour { public void Roar() {} } }');
    // Polling + debounce + FS settle = generous wait
    await new Promise((r) => setTimeout(r, 1500));
    const res = await vault.query({ text: 'Boss', topK: 5 });
    expect(res.hits.some((h) => h.chunk.path.endsWith('Boss.cs'))).toBe(true);
    await vault.stopWatch();
  });

  it('does not index unsupported or secret-like files reported by watcher hooks', async () => {
    await vault.init();
    writeFileSync(join(dir, '.env'), 'VAULT_SECRET=hidden');
    writeFileSync(join(dir, 'Assets/Scripts/credentials.json'), '{"token":"hidden"}');

    expect(await vault.reindexFile('.env')).toBe(false);
    expect(await vault.reindexFile('Assets/Scripts/credentials.json')).toBe(false);

    const indexedPaths = vault.listFiles().map((f) => f.path);
    expect(indexedPaths).not.toContain('.env');
    expect(indexedPaths).not.toContain('Assets/Scripts/credentials.json');
  });

  it('rejects reads through symlinks that escape the vault root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vault-outside-'));
    try {
      writeFileSync(join(outside, 'Leak.cs'), 'public class Leak {}');
      symlinkSync(join(outside, 'Leak.cs'), join(dir, 'Assets/Scripts/Leak.cs'));

      await expect(vault.readFile('Assets/Scripts/Leak.cs')).rejects.toThrow(/vault root|symlink|not allowed/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects writes through existing symlinks', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vault-outside-'));
    const outsideFile = join(outside, 'Note.md');
    try {
      writeFileSync(outsideFile, 'original');
      symlinkSync(outsideFile, join(dir, 'Note.md'));

      await expect(vault.writeFile('Note.md', 'changed')).rejects.toThrow(/symlink|vault root|not allowed/i);
      expect(await vault.readFile('ProjectSettings/ProjectVersion.txt')).toContain('m_EditorVersion');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects absolute read and write paths instead of treating them as relative', async () => {
    await expect(vault.readFile(join(dir, 'Assets/Scripts/Player.cs'))).rejects.toThrow(/path escapes vault root/i);
    await expect(vault.writeFile('/Note.md', 'changed')).rejects.toThrow(/path escapes vault root/i);
  });
});
