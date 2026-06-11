import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listIndexableFiles } from './discovery.js';
import { MAX_INDEXABLE_FILE_BYTES } from './path-policy.js';

describe('listIndexableFiles', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function buildFixtureTree(): { root: string } {
    const root = mkdtempSync(join(tmpdir(), 'strada-discovery-'));
    tempDirs.push(root);
    const outside = mkdtempSync(join(tmpdir(), 'strada-discovery-outside-'));
    tempDirs.push(outside);

    writeFileSync(join(root, 'a.md'), '# a');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1;');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.md'), '# dep');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'y.md'), '# git');
    mkdirSync(join(root, '.strada'));
    writeFileSync(join(root, '.strada', 'z.md'), '# strada');
    writeFileSync(join(root, 'secrets.json'), '{}');
    writeFileSync(join(root, 'appsettings.production.json'), '{}');
    writeFileSync(join(root, 'big.md'), Buffer.alloc(MAX_INDEXABLE_FILE_BYTES + 1, 0x61));
    const outsideFile = join(outside, 'outside.md');
    writeFileSync(outsideFile, '# outside');
    symlinkSync(outsideFile, join(root, 'linked.md'));
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    return { root };
  }

  it('includes indexable files with their language', async () => {
    const { root } = buildFixtureTree();
    const files = await listIndexableFiles(root);
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.get('a.md')?.lang).toBe('markdown');
    expect(byPath.get('src/b.ts')?.lang).toBe('typescript');
  });

  it('excludes ignored dirs, secrets, oversized files, symlinks, and unknown extensions', async () => {
    const { root } = buildFixtureTree();
    const files = await listIndexableFiles(root);
    const paths = files.map((f) => f.path);

    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.strada/'))).toBe(false);
    expect(paths).not.toContain('secrets.json');
    expect(paths).not.toContain('appsettings.production.json');
    expect(paths).not.toContain('big.md');
    expect(paths).not.toContain('linked.md');
    expect(paths).not.toContain('image.png');
    // Nothing unexpected slipped through.
    expect(paths.sort()).toEqual(['a.md', 'src/b.ts']);
  });

  it('returns root-relative paths with forward slashes', async () => {
    const { root } = buildFixtureTree();
    const files = await listIndexableFiles(root);

    for (const f of files) {
      expect(f.path.startsWith('/')).toBe(false);
      expect(f.path).not.toContain('\\');
      expect(f.path).not.toContain(root);
    }
  });
});
