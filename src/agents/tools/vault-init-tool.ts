import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

export class VaultInitTool {
  readonly name = 'vault_init';
  readonly description = 'Initialize an existing vault by ID, or register and initialize a vault from a project root path.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      vaultId: { type: 'string', description: 'Existing vault ID to initialize' },
      rootPath: { type: 'string', description: 'Project or vault root path to register and initialize' },
      path: { type: 'string', description: 'Alias for rootPath' },
    },
    required: [],
  };

  constructor(private registry: VaultRegistry) {}

  async execute(
    input: Record<string, unknown>,
    _context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const vaultId = typeof input['vaultId'] === 'string' ? input['vaultId'].trim() : '';
    const rootPath = typeof input['rootPath'] === 'string'
      ? input['rootPath'].trim()
      : (typeof input['path'] === 'string' ? input['path'].trim() : '');
    if (!vaultId && !rootPath) {
      return { content: 'Missing required parameter: vaultId or rootPath', isError: true };
    }

    let vault;
    try {
      vault = vaultId
        ? this.registry.get(vaultId)
        : await this.registry.createAndRegister(rootPath);
    } catch (err) {
      return {
        content: `vault init failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    if (!vault) return { content: `vault not found: ${vaultId}`, isError: true };
    await vault.init();
    const watchable = vault as unknown;
    if (hasStartWatch(watchable)) {
      await watchable.startWatch();
    }
    return { content: `vault ${vault.id} initialized` };
  }
}

function hasStartWatch(vault: unknown): vault is { startWatch(debounceMs?: number): Promise<void> } {
  return typeof (vault as { startWatch?: unknown }).startWatch === 'function';
}
