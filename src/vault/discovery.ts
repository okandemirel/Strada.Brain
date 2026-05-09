import { access, stat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { VaultFile } from './vault.interface.js';
import {
  EXT_LANG,
  IGNORE_DIRS,
  isIndexableVaultPath,
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

export async function listIndexableFiles(root: string): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  await walk(root, root, out);
  return out;
}

async function walk(root: string, dir: string, out: VaultFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Skip directories we can't read (permissions, deleted mid-walk, etc.)
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    if (e.isSymbolicLink()) continue;  // sec-H4: skip symlinks to prevent directory traversal.
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, full, out);
    } else if (e.isFile()) {
      const relPath = relative(root, full).replaceAll('\\', '/');
      const lang = langForVaultPath(relPath);
      if (!lang) continue;
      if (lang === 'json' && isSecretLikeJson(e.name)) continue;
      const st = await stat(full);
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
