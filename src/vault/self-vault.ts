import { readdir, lstat } from 'node:fs/promises';
import { join, relative, extname, basename, sep as pathSep } from 'node:path';
import { getLoggerSafe } from '../utils/logger.js';
import { UnityProjectVault, type UnityVaultDeps } from './unity-project-vault.js';
import { EXT_LANG } from './discovery.js';
import type { VaultFile } from './vault.interface.js';

/** Directory names skipped unconditionally during SelfVault walks. */
const SELF_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.strada',
  '.next', '.turbo', 'tmp', 'temp',
]);

/**
 * sec-H4: file/path patterns that must never be indexed into the SelfVault,
 * even when their directory survived the SELF_IGNORE filter. These cover
 * common credential/secret shapes and test fixtures that intentionally hold
 * fake secrets.
 *
 * Matched against the vault-relative POSIX path (never the absolute path).
 */
const SENSITIVE_EXTS = new Set(['.pem', '.key', '.p12', '.cert']);

function isSensitiveSelfPath(relPosix: string, fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  const lowerRel = relPosix.toLowerCase();
  // .env, .env.local, .env.production, etc.
  if (lowerName === '.env' || lowerName.startsWith('.env.')) return true;
  // credentials.* (credentials.json, credentials.yml, credentials.yaml, ...)
  if (lowerName === 'credentials' || lowerName.startsWith('credentials.')) return true;
  // PEM / KEY / P12 / CERT files anywhere in the tree.
  if (SENSITIVE_EXTS.has(extname(lowerName))) return true;
  // Test fixtures that intentionally hold fake/synthetic secrets.
  if (lowerRel.startsWith('tests/fixtures/secrets/')) return true;
  if (lowerRel.startsWith('tests/fixtures/') && lowerName.startsWith('credentials')) return true;
  return false;
}

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
    const relPosix = relative(root, full).replaceAll(pathSep, '/');
    // sec-H4: block sensitive file shapes regardless of parent directory.
    if (isSensitiveSelfPath(relPosix, e.name)) continue;
    out.push({
      path: relPosix,
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

  /**
   * Start a file watcher on the curated SELF_INCLUDE_ROOTS directories.
   * Unlike UnityProjectVault which watches the entire rootPath, SelfVault
   * only watches the source/test/doc directories that matter.
   */
  override async startWatch(debounceMs = 800): Promise<void> {
    if (this.watcher) return;
    const { VaultWatcher } = await import('./watcher.js');
    // Double-check after async import to prevent race conditions
    if (this.watcher) return;
    // SelfVault watches multiple roots; we create one watcher per root
    // and merge their updates through a shared emitter.
    const watchers: Array<{ start(): Promise<void>; stop(): Promise<void> }> = [];
    
    for (const root of SELF_INCLUDE_ROOTS) {
      const absRoot = join(this.rootPath, root);
      const st = await lstat(absRoot).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      const isFileRoot = st.isFile();
      
      const watcher = new VaultWatcher({
        root: absRoot,
        debounceMs,
        onBatch: async (paths) => {
          const rootPrefix = root.replaceAll(pathSep, '/');
          const relPaths = isFileRoot
            ? [rootPrefix]
            : paths.map((p) => {
              const child = p.replaceAll(pathSep, '/').replace(/^\/+/, '');
              return child ? `${rootPrefix}/${child}` : rootPrefix;
            });
          const changed: string[] = [];
          for (const p of relPaths) {
            try {
              if (await this.reindexFile(p)) changed.push(p);
            } catch (err) {
              getLoggerSafe().warn(`[vault ${this.id}] reindexFile failed for ${p}`, { err });
            }
          }
          if (changed.length) {
            await this.regenerateCanvas();
            this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
          }
        },
      });
      watchers.push(watcher);
    }
    
    // Composite watcher that starts/stops all underlying watchers
    this.watcher = {
      start: async () => {
        await Promise.all(watchers.map((w) => w.start()));
      },
      stop: async () => {
        await Promise.all(watchers.map((w) => w.stop()));
      },
    };
    await this.watcher.start();
  }

  // Override sync: use curated discovery roots (same as init) rather than Unity's file walker.
  override async sync(): Promise<{ changed: number; durationMs: number }> {
    const started = Date.now();
    const found = await this.discoverFiles();
    const before = new Set(this.store.listFiles().map((f) => f.path));
    const changed = await this.processFiles(found, before, 'sync');
    return { changed: changed.length, durationMs: Date.now() - started };
  }

  // Override init: use curated discovery roots rather than Unity's Assets/Packages layout.
  override async init(): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(this.rootPath, '.strada/vault/codebase'), { recursive: true });
    this.store.migrate();

    const found = await this.discoverFiles();
    await this.processFiles(found, new Set(), 'init');
  }

  /** Discover files from SELF_INCLUDE_ROOTS. */
  private async discoverFiles(): Promise<VaultFile[]> {
    const found: VaultFile[] = [];
    for (const r of SELF_INCLUDE_ROOTS) {
      const abs = join(this.rootPath, r);
      const st = await lstat(abs).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isFile()) {
        const lang = EXT_LANG[extname(abs).toLowerCase()];
        if (!lang) continue;
        const relPosix = relative(this.rootPath, abs).replaceAll(pathSep, '/');
        if (isSensitiveSelfPath(relPosix, basename(abs))) continue;
        found.push({
          path: relPosix, blobHash: '', mtimeMs: st.mtimeMs, size: st.size,
          lang, kind: 'doc', indexedAt: 0,
        });
      } else {
        await walk(this.rootPath, abs, found);
      }
    }
    return found;
  }

  /** Index discovered files and optionally remove deleted ones. */
  private async processFiles(
    found: VaultFile[],
    before: Set<string>,
    phase: 'init' | 'sync',
  ): Promise<string[]> {
    const changed: string[] = [];
    for (const f of found) {
      try {
        if (await this.reindexFile(f.path)) changed.push(f.path);
      } catch (err) {
        getLoggerSafe().warn(`[vault ${this.id}] skipping ${f.path} during ${phase}`, { err });
      }
    }

    if (phase === 'sync') {
      const present = new Set(found.map((f) => f.path));
      for (const p of before) {
        if (!present.has(p)) {
          const hnswIds = this.store.listHnswIdsForPath(p);
          for (const hnswId of hnswIds) this.adapter.remove(hnswId);
          this.store.deleteFile(p);
          changed.push(p);
        }
      }
    }

    await this.regenerateCanvas();
    if (changed.length) {
      this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
    }
    return changed;
  }
}
