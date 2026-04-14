import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

export class VaultStatusTool {
  readonly name = 'vault_status';
  readonly description = 'Show vault stats.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: { vaultId: { type: 'string', description: 'Vault ID (optional; omit for all vaults)' } },
    required: [],
  };

  constructor(private registry: VaultRegistry) {}

  async execute(
    input: Record<string, unknown>,
    _context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const vaultId = input['vaultId'] as string | undefined;
    const vaults = vaultId
      ? [this.registry.get(vaultId)].filter(Boolean)
      : this.registry.list();
    if (!vaults.length) {
      return { content: vaultId ? `vault not found: ${vaultId}` : 'no vaults registered' };
    }
    const lines: string[] = [];
    for (const v of vaults) {
      const s = await v!.stats();
      lines.push(`${v!.id}: ${s.fileCount} files, ${s.chunkCount} chunks, ${s.dbBytes}B`);
    }
    return { content: lines.join('\n') };
  }
}
