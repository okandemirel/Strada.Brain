import { access, stat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { VaultFile } from './vault.interface.js';
import {
  EXT_LANG,
  IGNORE_DIRS,
  isIndexableVaultPath,
  isPathGoneError,
  isSecretLikeJson,
  langForVaultPath,
} from './path-policy.js';

export interface UnityRoots {
  assets: string;
  projectSettings: string;
  packages: string;
}

export { EXT_LANG, isSecretLikeJson };

export async function discoverUnityRoots(root: string): Promise<UnityRoots | null> {
  const required = ['Assets', 'ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json'];
  for (const rel of required) {
    try { await access(join(root, rel)); }
    catch { return null; }
  }
  return { assets: 'Assets', projectSettings: 'ProjectSettings', packages: 'Packages' };
}

export interface IndexableFileScan {
  files: VaultFile[];
  /**
   * Vault-relative directories and files the walk could not read for a reason
   * other than "it is gone" ('.' for the root). What lies under them was not
   * listed, which is not the same as deleted.
   */
  unreadable: string[];
}

export async function listIndexableFiles(root: string): Promise<VaultFile[]> {
  return (await scanIndexableFiles(root)).files;
}

export async function scanIndexableFiles(root: string): Promise<IndexableFileScan> {
  const files: VaultFile[] = [];
  const unreadable: string[] = [];
  await walk(root, root, files, unreadable);
  return { files, unreadable };
}

/**
 * Whether `relPath` is, or lies under, a path the walk could not read. An
 * index pass prunes every indexed path its walk did not list; under an
 * unreadable directory "not listed" says nothing, so those rows stay.
 */
export function isUnderUnreadable(relPath: string, unreadable: readonly string[]): boolean {
  return unreadable.some((u) => u === '.' || relPath === u || relPath.startsWith(`${u}/`));
}

async function walk(root: string, dir: string, out: VaultFile[], unreadable: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Deleted mid-walk: its files really are gone. Anything else (EMFILE,
    // EACCES, EIO) left them unlisted, and the prune used to delete them.
    if (!isPathGoneError(err)) unreadable.push(relative(root, dir).replaceAll('\\', '/') || '.');
    return;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    if (e.isSymbolicLink()) continue;  // sec-H4: skip symlinks to prevent directory traversal.
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, full, out, unreadable);
    } else if (e.isFile()) {
      const relPath = relative(root, full).replaceAll('\\', '/');
      const lang = langForVaultPath(relPath);
      if (!lang) continue;
      if (lang === 'json' && isSecretLikeJson(e.name)) continue;
      let st;
      try {
        st = await stat(full);
      } catch (err) {
        if (!isPathGoneError(err)) unreadable.push(relPath);
        continue;
      }
      if (!isIndexableVaultPath(relPath, st.size)) continue;
      out.push({
        path: relPath,
        blobHash: '',
        mtimeMs: st.mtimeMs,
        size: st.size,
        lang,
        kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
        indexedAt: 0,
      });
    }
  }
}
