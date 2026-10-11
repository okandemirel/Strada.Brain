import { describe, expect, it } from 'vitest';
import { VaultInitTool } from './vault-init-tool.js';
import { VaultRegistry } from '../../vault/vault-registry.js';
import type { IVault } from '../../vault/vault.interface.js';

/**
 * The orchestrator's vault hint and the portal read registry.getInitState().
 * A vault the agent initialized through vault_init was never tracked, so while
 * it indexed it read "untracked" (a partial file count, not "still indexing")
 * and the portal showed no state for it — the gap bootstrap's vaults had.
 */
function deferredVault(id: string): { vault: IVault; finish: () => void } {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const vault = {
    id,
    kind: 'generic',
    rootPath: process.cwd(),
    init: () => done,
    dispose: async () => {},
  } as unknown as IVault;
  return { vault, finish };
}

describe('vault_init tracks the init it runs', () => {
  it('reports indexing while the walk runs, and ready once it finishes', async () => {
    const registry = new VaultRegistry();
    const { vault, finish } = deferredVault('generic:abc12345');
    registry.register(vault);

    const running = new VaultInitTool(registry).execute({ vaultId: 'generic:abc12345' });
    await Promise.resolve();
    expect(registry.getInitState('generic:abc12345')?.status).toBe('indexing');

    finish();
    const result = await running;
    expect(result.isError).toBeFalsy();
    expect(registry.getInitState('generic:abc12345')?.status).toBe('ready');
  });
});
