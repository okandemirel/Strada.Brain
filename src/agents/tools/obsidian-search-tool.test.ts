import { describe, expect, it, vi } from 'vitest';
import { ObsidianSearchTool } from './obsidian-search-tool.js';
import type { VaultRegistry } from '../../vault/vault-registry.js';

describe('ObsidianSearchTool', () => {
  it('falls back to the local vault index when the Obsidian API is unavailable', async () => {
    const vault = {
      id: 'obsidian:test',
      kind: 'obsidian',
      searchObsidian: vi.fn().mockRejectedValue(new Error('offline')),
      query: vi.fn().mockResolvedValue({
        hits: [
          {
            chunk: {
              chunkId: 'c1',
              path: 'Folder/Sub.md',
              startLine: 1,
              endLine: 2,
              content: 'NestedNeedle',
              tokenCount: 1,
            },
            scores: { fts: 1, hnsw: null, rrf: 0.1 },
          },
        ],
        budgetUsed: 1,
        truncated: false,
      }),
    };
    const registry = {
      list: () => [vault],
      get: (id: string) => id === vault.id ? vault : undefined,
    } as unknown as VaultRegistry;

    const result = await new ObsidianSearchTool(registry).execute({ query: 'NestedNeedle' });

    expect(vault.searchObsidian).toHaveBeenCalled();
    expect(vault.query).toHaveBeenCalledWith({ text: 'NestedNeedle', topK: 10 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Folder/Sub.md');
    expect(result.content).toContain('local fallback');
  });

  it('reports fallback failures without throwing the tool call', async () => {
    const vault = {
      id: 'obsidian:test',
      kind: 'obsidian',
      searchObsidian: vi.fn().mockRejectedValue(new Error('api offline')),
      query: vi.fn().mockRejectedValue(new Error('index unavailable')),
    };
    const registry = {
      list: () => [vault],
      get: (id: string) => id === vault.id ? vault : undefined,
    } as unknown as VaultRegistry;

    const result = await new ObsidianSearchTool(registry).execute({ query: 'NestedNeedle' });

    expect(vault.searchObsidian).toHaveBeenCalled();
    expect(vault.query).toHaveBeenCalledWith({ text: 'NestedNeedle', topK: 10 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('api offline');
    expect(result.content).toContain('local fallback failed: index unavailable');
  });
});
