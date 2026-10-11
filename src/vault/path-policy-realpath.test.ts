import { afterEach, describe, expect, it, vi } from 'vitest';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    realpaths.set(join(root, 'a.md'), join(realpathSync(outside), 'a.md'));

    // A throw here is read as a transient I/O error, which keeps the rows.
    await expect(getIndexableFileInfo(root, 'a.md')).resolves.toEqual({
      ok: false,
      relPath: 'a.md',
      reason: 'escapes vault root',
    });
  });

  it('is judged again under the name the disk gives it when it stays inside', async () => {
    const root = tmp.makeDir();
    writeFileSync(join(root, 'notes.md'), '# n');
    // A case-insensitive filesystem answers .GIT/... with .git/...
    realpaths.set(join(root, 'notes.md'), join(realpathSync(root), '.git', 'notes.md'));

    await expect(getIndexableFileInfo(root, 'notes.md')).resolves.toEqual({
      ok: false,
      relPath: 'notes.md',
      reason: 'not indexable',
    });
  });
});
