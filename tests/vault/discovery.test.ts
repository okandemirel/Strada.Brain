import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { discoverUnityRoots, listIndexableFiles } from '../../src/vault/discovery.js';

const fixture = join(process.cwd(), 'tests/fixtures/unity-mini');

describe('discovery', () => {
  it('detects Unity project by sentinels', async () => {
    expect(await discoverUnityRoots(fixture))
      .toEqual({ assets: 'Assets', projectSettings: 'ProjectSettings', packages: 'Packages' });
  });

  it('returns null for non-Unity dirs', async () => {
    expect(await discoverUnityRoots(process.cwd())).toBeNull();
  });

  it('lists .cs files under Assets/', async () => {
    const files = await listIndexableFiles(fixture);
    const cs = files.filter((f) => f.lang === 'csharp').map((f) => f.path.replaceAll('\\', '/'));
    expect(cs).toContain('Assets/Scripts/Player.cs');
    expect(cs).toContain('Assets/Scripts/Enemy.cs');
  });

  it('ignores Library/Temp/obj/bin', async () => {
    const files = await listIndexableFiles(fixture);
    expect(files.every((f) => !/\/(Library|Temp|obj|bin)\//.test(f.path))).toBe(true);
  });

  it('does not list oversized files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-discovery-'));
    try {
      writeFileSync(join(dir, 'Huge.ts'), 'x'.repeat(2 * 1024 * 1024 + 1));
      const files = await listIndexableFiles(dir);
      expect(files.map((f) => f.path)).not.toContain('Huge.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
