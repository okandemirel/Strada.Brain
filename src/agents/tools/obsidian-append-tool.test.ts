import { describe, expect, it, vi } from 'vitest';
import { ObsidianAppendTool } from './obsidian-append-tool.js';
import type { ToolContext } from './tool.interface.js';
import type { VaultRegistry } from '../../vault/vault-registry.js';

function makeRegistry() {
  const vault = {
    id: 'obsidian:test',
    kind: 'obsidian',
    appendToHeading: vi.fn().mockResolvedValue(undefined),
    writeNote: vi.fn().mockResolvedValue(undefined),
  };
  const registry = {
    list: () => [vault],
    get: (id: string) => (id === vault.id ? vault : undefined),
  } as unknown as VaultRegistry;
  return { vault, registry };
}

function context(readOnly: boolean): ToolContext {
  return { projectPath: '/project', workingDirectory: '/project', readOnly } as ToolContext;
}

describe('ObsidianAppendTool', () => {
  it('appends under a heading when writes are allowed', async () => {
    const { vault, registry } = makeRegistry();
    const result = await new ObsidianAppendTool(registry).execute(
      { path: 'Daily/today.md', heading: '## Notes', content: 'x' },
      context(false),
    );
    expect(result.isError).toBeFalsy();
    expect(vault.appendToHeading).toHaveBeenCalledWith('Daily/today.md', '## Notes', 'x');
  });

  it('refuses to write in read-only mode', async () => {
    const { vault, registry } = makeRegistry();
    const tool = new ObsidianAppendTool(registry);

    const withHeading = await tool.execute(
      { path: 'Daily/today.md', heading: '## Notes', content: 'x' },
      context(true),
    );
    const withoutHeading = await tool.execute({ path: 'Daily/today.md', content: 'x' }, context(true));

    for (const result of [withHeading, withoutHeading]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('read-only mode');
    }
    expect(vault.appendToHeading).not.toHaveBeenCalled();
    expect(vault.writeNote).not.toHaveBeenCalled();
  });
});
