import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

export class VaultSyncTool {
  readonly name = 'vault_sync';
  readonly description = 'Reindex changed files in a vault.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: { vaultId: { type: 'string', description: 'Vault ID to sync' } },
    required: ['vaultId'],
  };

  constructor(private registry: VaultRegistry) {}

  async execute(
    input: Record<string, unknown>,
    _context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const vaultId = input['vaultId'] as string | undefined;
    if (!vaultId) return { content: 'Missing required parameter: vaultId', isError: true };
    const v = this.registry.get(vaultId);
    if (!v) return { content: `vault not found: ${vaultId}`, isError: true };
    const r = await v.sync();
    return { content: `sync ${vaultId}: ${r.changed} file(s) reindexed in ${r.durationMs}ms` };
  }
}
