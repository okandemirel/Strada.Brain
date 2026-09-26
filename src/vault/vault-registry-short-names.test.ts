/**
 * On Windows the plain realpathSync resolves symlinks only: an 8.3 short name
 * (C:\Users\RUNNER~1\..., often what os.tmpdir() returns) comes back as typed.
 * Only the native realpath — the one validatePath and resolveExistingVaultRoot
 * use — expands it (C:\Users\runneradmin\...). The registry compared its roots
 * in the plain spelling and every other path in the native one, so on Windows
 * no file_read found its vault, and createAndRegister opened a second vault for
 * a root already registered (MEM-7).
 *
 * Linux has no short names, so node:fs is given one: `shortName.from` names
 * `shortName.to`, and only realpathSync.native expands it, as on Windows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { VaultRegistry } from './vault-registry.js';
import { createFakeVault } from '../test-helpers.js';

const shortName = vi.hoisted(() => ({ from: '', to: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isShort = (p: unknown): p is string =>
    typeof p === 'string' && shortName.from !== '' && (p === shortName.from || p.startsWith(shortName.from + sep));
  const realpathSyncWithShortNames = Object.assign(
    (p: string): string => (isShort(p) ? p : actual.realpathSync(p)),
    {
      native: (p: string): string =>
        isShort(p) ? shortName.to + p.slice(shortName.from.length) : actual.realpathSync.native(p),
    },
  );
  return { ...actual, realpathSync: realpathSyncWithShortNames };
});

describe('a vault root spelled with a Windows 8.3 short name', () => {
  let base = '';

  function setUp(): { short: string; long: string } {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'vault-short-name-')));
    const long = join(base, 'project-with-a-long-name');
    mkdirSync(join(long, 'src'), { recursive: true });
    shortName.from = join(base, 'PROJEC~1');
    shortName.to = long;
    return { short: shortName.from, long };
  }

  afterEach(() => {
    shortName.from = '';
    shortName.to = '';
    if (base !== '') rmSync(base, { recursive: true, force: true });
    base = '';
  });

  it('owns the files file_read names in the long spelling', () => {
    const { short, long } = setUp();
    const registry = new VaultRegistry();
    const vault = createFakeVault({ id: 'unity:short', rootPath: short });
    registry.register(vault);

    expect(registry.resolveVaultForPath(join(long, 'src', 'a.ts'))).toBe(vault);
    expect(registry.resolveVaultForPath(join(short, 'src', 'a.ts'))).toBe(vault);
  });

  it('is the vault createAndRegister returns for the same root in the long spelling', async () => {
    const { short, long } = setUp();
    const registry = new VaultRegistry();
    const vault = createFakeVault({ id: 'unity:short', rootPath: short });
    registry.register(vault);
    const createVault = vi.fn((rootPath: string) => createFakeVault({ id: 'generic:new', rootPath }));
    registry.setFactory({ createVault, allowedRootPaths: [base] });

    await expect(registry.createAndRegister(long)).resolves.toBe(vault);
    expect(createVault).not.toHaveBeenCalled();
  });
});
