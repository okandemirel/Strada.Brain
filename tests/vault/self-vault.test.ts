import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfVault } from '../../src/vault/self-vault.js';

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

describe('SelfVault', () => {
  let dir: string; let vault: SelfVault | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-vault-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const x = 1;');
    mkdirSync(join(dir, 'src/sub'));
    writeFileSync(join(dir, 'src/sub/b.ts'), 'export const y = 2;');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/bundle.js'), '// built');
    writeFileSync(join(dir, 'package.json'), '{"name":"strada-brain"}');
  });
  afterEach(async () => { if (vault) await vault.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it('indexes src/**/*.ts but not dist/', async () => {
    vault = new SelfVault({
      id: 'self:test', rootPath: dir,
      embedding: new StubEmb() as never, vectorStore: new StubStore() as never,
    });
    await vault.init();
    const paths = vault.listFiles().map((f) => f.path).sort();
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/sub/b.ts');
    expect(paths.every((p) => !p.startsWith('dist/'))).toBe(true);
  });

  it('kind is "self"', () => {
    vault = new SelfVault({
      id: 'self:test', rootPath: dir,
      embedding: new StubEmb() as never, vectorStore: new StubStore() as never,
    });
    expect(vault.kind).toBe('self');
  });
});
