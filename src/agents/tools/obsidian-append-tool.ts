import type { ObsidianVault } from '../../vault/obsidian-vault.js';
import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

/**
 * Append content to a heading in an Obsidian note.
 * Creates the note if it does not exist.
 */
export class ObsidianAppendTool {
  readonly name = 'obsidian_append';
  readonly description =
    'Append content to a specific heading in an Obsidian note. ' +
    'If the note does not exist, it will be created. ' +
    'Requires an obsidian vault to be registered and the Obsidian Local REST API plugin to be active.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Vault-relative path to the note (e.g. "Daily/2024-01-15.md").',
      },
      heading: {
        type: 'string',
        description: 'Heading to append under (e.g. "## Notes"). If omitted, appends to end of file.',
      },
      content: {
        type: 'string',
        description: 'Content to append.',
      },
      vaultId: {
        type: 'string',
        description: 'Obsidian vault ID. Omit to use the first registered obsidian vault.',
      },
    },
    required: ['path', 'content'],
  };

  constructor(private registry: VaultRegistry) {}

  async execute(
    input: Record<string, unknown>,
    _context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const path = typeof input['path'] === 'string' ? input['path'].trim() : '';
    if (!path) {
      return { content: "Error: 'path' is required", isError: true };
    }
    const content = typeof input['content'] === 'string' ? input['content'] : '';
    if (!content) {
      return { content: "Error: 'content' is required", isError: true };
    }
    const heading = typeof input['heading'] === 'string' ? input['heading'].trim() : undefined;

    const vaultId = typeof input['vaultId'] === 'string' ? input['vaultId'] : undefined;
    const targetVaults = vaultId
      ? [this.registry.get(vaultId)].filter(Boolean)
      : this.registry.list().filter((v) => v.kind === 'obsidian');

    if (!targetVaults.length) {
      return {
        content: vaultId
          ? `vault not found: ${vaultId}`
          : 'no obsidian vaults registered. Register one with /vault init or enable obsidian in setup.',
        isError: true,
      };
    }

    const vault = targetVaults[0] as ObsidianVault;
    try {
      if (heading) {
        await vault.appendToHeading(path, heading, content);
      } else {
        await vault.writeNote(path, content);
      }
      return {
        content: `appended to ${path}${heading ? ` under "${heading}"` : ''} in vault ${vault.id}`,
      };
    } catch (err) {
      return {
        content: `failed to append to ${path}: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
