import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { IVault, VaultId, VaultQuery, VaultQueryResult, VaultHit } from './vault.interface.js';

/**
 * Safely resolve a realpath. Falls back to the input when the path does
 * not exist or realpath fails for any reason — callers should still get
 * a deterministic, canonicalish path to compare against vault roots.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export class VaultRegistry {
  private vaults = new Map<VaultId, IVault>();
  /**
   * Cache of realpath(rootPath) keyed by the original rootPath string.
   * Populated at register() time to avoid per-call realpathSync cost.
   */
  private rootRealpathCache = new Map<string, string>();

  register(v: IVault): void {
    this.vaults.set(v.id, v);
    this.rootRealpathCache.set(v.rootPath, safeRealpath(v.rootPath));
  }
  unregister(id: VaultId): void {
    const v = this.vaults.get(id);
    if (v) this.rootRealpathCache.delete(v.rootPath);
    this.vaults.delete(id);
  }
  get(id: VaultId): IVault | undefined { return this.vaults.get(id); }
  list(): IVault[] { return [...this.vaults.values()]; }

  /**
   * Resolve the registered vault whose rootPath is a prefix of the given
   * absolute or relative path. Longest-prefix wins to handle nested vaults.
   *
   * Security: both the input path and each vault rootPath are normalized
   * via `realpathSync` (cached for roots) before prefix comparison. This
   * prevents symlink-based escapes and handles callers that pass non-
   * canonical paths (e.g. /var vs /private/var on macOS).
   *
   * Returns `undefined` if no vault owns the path.
   */
  resolveVaultForPath(absOrRelPath: string, cwd?: string): IVault | undefined {
    const resolved = isAbsolute(absOrRelPath)
      ? absOrRelPath
      : resolve(cwd ?? process.cwd(), absOrRelPath);
    const abs = safeRealpath(resolved);
    let best: IVault | undefined;
    let bestLen = -1;
    for (const v of this.vaults.values()) {
      const rootCanonical = this.rootRealpathCache.get(v.rootPath) ?? safeRealpath(v.rootPath);
      const root = rootCanonical.endsWith(sep) ? rootCanonical : rootCanonical + sep;
      const candidate = abs.endsWith(sep) ? abs : abs + sep;
      if (candidate.startsWith(root) && root.length > bestLen) {
        best = v;
        bestLen = root.length;
      }
    }
    return best;
  }

  async query(q: VaultQuery, vaultIds?: VaultId[]): Promise<VaultQueryResult> {
    const targets = vaultIds?.length
      ? vaultIds.map((id) => this.vaults.get(id)).filter((v): v is IVault => !!v)
      : [...this.vaults.values()];
    const results = await Promise.all(targets.map((v) => v.query(q)));
    const merged: VaultHit[] = [];
    for (const r of results) merged.push(...r.hits);
    merged.sort((a, b) => b.scores.rrf - a.scores.rrf);
    const capped = q.topK ? merged.slice(0, q.topK) : merged;
    return {
      hits: capped,
      budgetUsed: capped.reduce((a, h) => a + h.chunk.tokenCount, 0),
      truncated: capped.length < merged.length,
    };
  }

  async disposeAll(): Promise<void> {
    for (const v of this.vaults.values()) await v.dispose();
    this.vaults.clear();
    this.rootRealpathCache.clear();
  }
}
