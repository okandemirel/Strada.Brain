import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createTempDirTracker } from '../test-helpers.js';
import { getIndexableFileInfo } from './path-policy.js';

// realpath is where a file swapped for a link after the lstat checks shows up,
// so it is the one answer that can put a vetted path outside the root.
const realpaths = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (path: string) => realpaths.get(String(path)) ?? actual.realpath(path),
  };
});

// The code judges against the native realpath of the root. The JS
// realpathSync keeps a component as the caller spelled it, so an expectation
// built with it misses on a root the disk spells differently: Windows' 8.3
// TEMP (C:\Users\RUNNER~1\...), or another case on a case-insensitive disk.
const diskRealpath = realpathSync.native;

/** `dir` with its last name in another case, or null where the disk tells cases apart. */
function respelledInAnotherCase(dir: string): string | null {
  const name = basename(dir);
  const other = name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase();
  const respelled = join(dirname(dir), other);
  return other !== name && existsSync(respelled) ? respelled : null;
}

describe('getIndexableFileInfo: a real path outside the root', () => {
  const tmp = createTempDirTracker('strada-path-policy-realpath-');

  afterEach(() => {
    realpaths.clear();
    tmp.cleanup();
  });

  it('is rejected as escaping the root, so the index drops the path instead of keeping its rows', async () => {
    const root = tmp.makeDir();
    const outside = tmp.makeDir();
    writeFileSync(join(root, 'a.md'), '# a');
    writeFileSync(join(outside, 'a.md'), '# not the vault');
    realpaths.set(join(root, 'a.md'), join(diskRealpath(outside), 'a.md'));

    // A throw here is read as a transient I/O error, which keeps the rows.
    await expect(getIndexableFileInfo(root, 'a.md')).resolves.toEqual({
      ok: false,
      relPath: 'a.md',
      reason: 'escapes vault root',
    });
  });

  it.for([
    ['as the disk spells it', (dir: string): string | null => dir],
    ['spelled differently from the disk', respelledInAnotherCase],
  ] as const)('is judged again under the name the disk gives it when it stays inside (root %s)', async ([, spell], ctx) => {
    const created = tmp.makeDir();
    const root = spell(created);
    if (root === null) return ctx.skip();
    writeFileSync(join(created, 'notes.md'), '# n');
    // A case-insensitive filesystem answers .GIT/... with .git/...
    realpaths.set(join(root, 'notes.md'), join(diskRealpath(root), '.git', 'notes.md'));

    await expect(getIndexableFileInfo(root, 'notes.md')).resolves.toEqual({
      ok: false,
      relPath: 'notes.md',
      reason: 'not indexable',
    });
  });
});
