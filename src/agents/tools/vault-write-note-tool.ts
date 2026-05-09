import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

export class VaultWriteNoteTool {
  readonly name = 'vault_write_note';
  readonly description =
    'Write a note or markdown file into a vault. ' +
    'Use this to persist agent analysis, summaries, decisions, or incident reports ' +
    'so they appear in the vault graph and Obsidian. ' +
    'The path should use forward slashes and include the .md extension. ' +
    'Notes written via this tool are immediately searchable in the vault and visible in the graph.';

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Vault-relative file path (e.g. "analysis/PlayerModule.md").',
      },
      content: {
        type: 'string',
        description: 'Markdown content to write.',
      },
      vaultId: {
        type: 'string',
        description: 'Target vault id. Omit to write to the project vault.',
      },
    },
    required: ['path', 'content'],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const registry = context.vaultRegistry;
    if (!registry) {
      return {
        content: 'vault unavailable: no vault registry attached to this session',
        metadata: { executionTimeMs: 0 },
      };
    }

    const path = typeof input['path'] === 'string' ? input['path'] : '';
    const content = typeof input['content'] === 'string' ? input['content'] : '';
    const vaultId = typeof input['vaultId'] === 'string' ? input['vaultId'] : undefined;

    if (!path) {
      return { content: "Error: 'path' is required", isError: true };
    }
    if (!content) {
      return { content: "Error: 'content' is required", isError: true };
    }

    let targetVaults;
    if (vaultId) {
      const vault = registry.get(vaultId);
      targetVaults = vault ? [vault] : [];
    } else if (context.projectPath) {
      const projectVault = registry.resolveVaultForPath(context.projectPath, context.projectPath);
      targetVaults = projectVault ? [projectVault] : registry.list();
    } else {
      targetVaults = registry.list();
    }

    if (!targetVaults.length) {
      return { content: vaultId ? `vault not found: ${vaultId}` : 'no vaults registered', isError: true };
    }

    const started = Date.now();
    const written: string[] = [];
    const errors: string[] = [];

    for (const vault of targetVaults) {
      if (!vault.writeFile) {
        errors.push(`${vault.id}: writeFile not supported`);
        continue;
      }
      try {
        await vault.writeFile(path, content);
        if (hasReindexFile(vault)) {
          await vault.reindexFile(path);
        }
        if (hasRegenerateCanvas(vault)) {
          await vault.regenerateCanvas();
        }
        written.push(vault.id);
      } catch (err) {
        errors.push(`${vault.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!written.length) {
      return {
        content: `write failed for all vaults:\n${errors.join('\n')}`,
        isError: true,
        metadata: { executionTimeMs: Date.now() - started },
      };
    }

    return {
      content: `written to ${written.join(', ')}${errors.length ? `\n(warnings: ${errors.join(', ')})` : ''}`,
      metadata: { executionTimeMs: Date.now() - started, vaultsWritten: written.length },
    };
  }
}

function hasReindexFile(vault: unknown): vault is { reindexFile(path: string): Promise<boolean> } {
  return typeof (vault as { reindexFile?: unknown }).reindexFile === 'function';
}

function hasRegenerateCanvas(vault: unknown): vault is { regenerateCanvas(): Promise<void> } {
  return typeof (vault as { regenerateCanvas?: unknown }).regenerateCanvas === 'function';
}
