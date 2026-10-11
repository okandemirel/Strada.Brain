import { canonicalVaultPath } from '../../vault/path-policy.js';
import type { IVault } from '../../vault/vault.interface.js';
import { vaultNotFound } from './vault-not-found.js';
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
    // The project vault writes into the project tree, so the tool refuses on
    // its own rather than trusting every dispatch path to have filtered it.
    if (context.readOnly) {
      return { content: 'Error: writing vault notes is disabled in read-only mode', isError: true };
    }
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

    let targetVaults: IVault[];
    if (vaultId) {
      const vault = registry.resolve(vaultId);
      if (!vault) {
        return { content: vaultNotFound(vaultId, registry.ids()), isError: true };
      }
      targetVaults = [vault];
    } else {
      // sourceProjectPath first: under a workspace lease `projectPath` is the
      // lease directory, which no vault is registered against. The miss used to
      // fall back to every registered vault, so one note landed in the game,
      // the vendored Strada.Core and Strada.MCP packages, the knowledge vault
      // and Strada.Brain's own tree. An unresolved project is now a refusal.
      const lookupPath = context.sourceProjectPath || context.projectPath;
      const owner = lookupPath ? registry.resolveVaultForPath(lookupPath, lookupPath) : undefined;
      if (!owner || !ownsProject(owner, lookupPath)) {
        const ids = registry.ids();
        return {
          content: ids.length
            ? `Error: no vault is registered for this project, so nothing was written. Pass vaultId to choose one: ${ids.join(', ')}`
            : 'no vaults registered',
          isError: true,
        };
      }
      targetVaults = [owner];
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

/**
 * Bootstrap's own test for "this vault indexes the project": rooted at it, or
 * a project-code vault above it. A self, Obsidian or knowledge vault above the
 * project only contains it, and writing there puts the note in another tree.
 */
function ownsProject(vault: IVault, projectRoot: string): boolean {
  return vault.kind === 'unity-project' || canonicalVaultPath(vault.rootPath) === canonicalVaultPath(projectRoot);
}

function hasReindexFile(vault: unknown): vault is { reindexFile(path: string): Promise<boolean> } {
  return typeof (vault as { reindexFile?: unknown }).reindexFile === 'function';
}

function hasRegenerateCanvas(vault: unknown): vault is { regenerateCanvas(): Promise<void> } {
  return typeof (vault as { regenerateCanvas?: unknown }).regenerateCanvas === 'function';
}
