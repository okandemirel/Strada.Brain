import { readdir, lstat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { UnityProjectVault, type UnityVaultDeps } from './unity-project-vault.js';
import { EXT_LANG } from './discovery.js';
import type { VaultFile } from './vault.interface.js';

const SELF_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.strada',
  '.next', '.turbo', 'tmp', 'temp',
]);

const SELF_INCLUDE_ROOTS = [
  'src',
  'web-portal/src',
  'tests',
  'docs',
  'AGENTS.md',
  'CLAUDE.md',
];

async function walk(root: string, dir: string, out: VaultFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SELF_IGNORE.has(e.name)) continue;
    // phase2-review M1: Dirent fields don't follow symlinks, but we still lstat and skip
    // symlinked files/dirs outright so a hostile `tests/fixtures/evil → /etc/...` entry
    // can never be indexed or broadcast via the graph canvas.
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    if (!e.isFile()) continue;
    const lang = EXT_LANG[extname(e.name).toLowerCase()];
    if (!lang) continue;
    const st = await lstat(full).catch(() => null);
    if (!st || st.isSymbolicLink()) continue;
    out.push({
      path: relative(root, full).replaceAll('\\', '/'),
      blobHash: '',
      mtimeMs: st.mtimeMs,
      size: st.size,
      lang,
      kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
      indexedAt: 0,
    });
  }
}

export class SelfVault extends UnityProjectVault {
  override readonly kind = 'self' as const;

  constructor(deps: UnityVaultDeps) {
    super(deps);
  }

  // Override init: use curated discovery roots rather than Unity's Assets/Packages layout.
  override async init(): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(this.rootPath, '.strada/vault/codebase'), { recursive: true });
    this.store.migrate();

    const found: VaultFile[] = [];
    for (const r of SELF_INCLUDE_ROOTS) {
      const abs = join(this.rootPath, r);
      // phase2-review M1: lstat (don't follow symlinks even at the root level).
      const st = await lstat(abs).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isFile()) {
        const lang = EXT_LANG[extname(abs).toLowerCase()];
        if (!lang) continue;
        found.push({
          path: relative(this.rootPath, abs).replaceAll('\\', '/'),
          blobHash: '',
          mtimeMs: st.mtimeMs,
          size: st.size,
          lang,
          kind: 'doc',
          indexedAt: 0,
        });
      } else {
        await walk(this.rootPath, abs, found);
      }
    }

    const changed: string[] = [];
    for (const f of found) {
      if (await this.reindexFile(f.path)) changed.push(f.path);
    }
    await this.regenerateCanvas();
    if (changed.length) {
      this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
    }
  }
}
