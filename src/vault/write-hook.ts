import { relative, isAbsolute, resolve } from 'node:path';
import type { IVault } from './vault.interface.js';

export interface WriteHookOptions {
  vault: IVault & { reindexFile: (relPath: string) => Promise<boolean> };
  budgetMs: number;
}

export interface InstalledWriteHook {
  afterWrite(absOrRelPath: string): Promise<string | null>;
}

export function installWriteHook(opts: WriteHookOptions): InstalledWriteHook {
  return {
    async afterWrite(absOrRelPath: string): Promise<string | null> {
      const abs = isAbsolute(absOrRelPath) ? absOrRelPath : resolve(opts.vault.rootPath, absOrRelPath);
      const rel = relative(opts.vault.rootPath, abs).replaceAll('\\', '/');
      if (rel.startsWith('..')) return null;
      const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), opts.budgetMs));
      const workPromise = opts.vault.reindexFile(rel).then(() => 'ok' as const);
      const outcome = await Promise.race([workPromise, timeoutPromise]);
      if (outcome === 'timeout') {
        void workPromise.catch(() => undefined);
        return `vault may be stale for ${rel} (reindex exceeded ${opts.budgetMs}ms)`;
      }
      return null;
    },
  };
}
