import { access, stat, readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { VaultFile } from './vault.interface.js';

export interface UnityRoots {
  assets: string;
  projectSettings: string;
  packages: string;
}

const IGNORE = new Set(['Library', 'Temp', 'Logs', 'obj', 'bin', '.git', 'node_modules', '.strada']);
const EXT_LANG: Record<string, VaultFile['lang']> = {
  '.cs': 'csharp', '.ts': 'typescript', '.tsx': 'typescript',
  '.md': 'markdown', '.json': 'json',
  '.hlsl': 'hlsl', '.shader': 'hlsl', '.cginc': 'hlsl',
};

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
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, full, out);
    } else if (e.isFile()) {
      const lang = EXT_LANG[extname(e.name).toLowerCase()];
      if (!lang) continue;
      const st = await stat(full);
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
}
