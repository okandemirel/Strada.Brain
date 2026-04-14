import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

export class VaultInitTool {
  readonly name = 'vault_init';
  readonly description = 'Initialize a vault by ID.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: { vaultId: { type: 'string', description: 'Vault ID to initialize' } },
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
    await v.init();
    return { content: `vault ${vaultId} initialized` };
  }
}
