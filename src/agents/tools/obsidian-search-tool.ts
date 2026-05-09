import type { ObsidianVault } from '../../vault/obsidian-vault.js';
import type { VaultRegistry } from '../../vault/vault-registry.js';
import type { ToolContext, ToolExecutionResult } from './tool.interface.js';

/**
 * Search an Obsidian vault using its native fuzzy search.
 * Falls back to local vault index if Obsidian API is unreachable.
 */
export class ObsidianSearchTool {
  readonly name = 'obsidian_search';
  readonly description =
    "Search an Obsidian vault using Obsidian's built-in fuzzy search. " +
    'Returns ranked filenames with match snippets. ' +
    'Requires an obsidian vault to be registered and the Obsidian Local REST API plugin to be active.';
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Free-text search query (min 2 chars).',
      },
      vaultId: {
        type: 'string',
        description: "Obsidian vault ID. Omit to use the project's default vault.",
      },
    },
    required: ['query'],
  };

  constructor(private registry: VaultRegistry) {}

  async execute(
    input: Record<string, unknown>,
    _context?: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
    if (query.length < 2) {
      return { content: "Error: 'query' must be at least 2 characters", isError: true };
    }

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

    const results: string[] = [];
    for (const v of targetVaults) {
      const vault = v as ObsidianVault;
      try {
        const hits = await vault.searchObsidian(query);
        if (hits.length) {
          results.push(`--- ${vault.id} (${hits.length} hits) ---`);
          for (const h of hits) {
            results.push(`  ${h.filename} (score=${h.score.toFixed(3)})`);
            for (const m of h.matches.slice(0, 3)) {
              results.push(`    - ${m}`);
            }
          }
        }
      } catch (err) {
        try {
          const fallback = await vault.query({ text: query, topK: 10 });
          if (fallback.hits.length) {
            results.push(`--- ${vault.id} (local fallback after Obsidian API error: ${(err as Error).message}) ---`);
            for (const hit of fallback.hits.slice(0, 10)) {
              results.push(`  ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine} (score=${hit.scores.rrf.toFixed(3)})`);
              results.push(`    - ${hit.chunk.content.slice(0, 160).replace(/\s+/g, ' ')}`);
            }
          } else {
            results.push(`--- ${vault.id} (error: ${(err as Error).message}; local fallback had no hits) ---`);
          }
        } catch (fallbackErr) {
          results.push(
            `--- ${vault.id} (error: ${(err as Error).message}; local fallback failed: ${(fallbackErr as Error).message}) ---`,
          );
        }
      }
    }

    if (!results.length) {
      return { content: `no obsidian hits for "${query}"` };
    }

    return { content: results.join('\n') };
  }
}
