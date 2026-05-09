import { describe, it, expect, vi } from 'vitest';
import { VaultWriteNoteTool } from './vault-write-note-tool.js';
import type { ToolContext } from './tool.interface.js';

function makeVault(overrides: { id?: string; supportsWrite?: boolean; failWrite?: boolean; supportsRefresh?: boolean } = {}) {
  return {
    id: overrides.id ?? 'v1',
    writeFile: overrides.supportsWrite !== false
      ? overrides.failWrite
        ? vi.fn().mockRejectedValue(new Error('disk full'))
        : vi.fn().mockResolvedValue(undefined)
      : undefined,
    reindexFile: overrides.supportsRefresh === true ? vi.fn().mockResolvedValue(true) : undefined,
    regenerateCanvas: overrides.supportsRefresh === true ? vi.fn().mockResolvedValue(undefined) : undefined,
  } as never;
}

function makeContext(vaults: ReturnType<typeof makeVault>[]): ToolContext {
  return {
    vaultRegistry: {
      list: () => vaults,
      get: (id: string) => vaults.find((v) => v.id === id),
      resolveVaultForPath: (_path: string, _projectPath: string) => vaults[0] ?? undefined,
    } as never,
    projectPath: '/project',
  } as ToolContext;
}

describe('VaultWriteNoteTool', () => {
  const tool = new VaultWriteNoteTool();

  it('writes content to a vault', async () => {
    const vault = makeVault({ supportsWrite: true });
    const result = await tool.execute(
      { path: 'notes/test.md', content: '# Hello' },
      makeContext([vault]),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('written to v1');
    expect(vault.writeFile).toHaveBeenCalledWith('notes/test.md', '# Hello');
  });

  it('refreshes index and canvas after writing when the vault supports it', async () => {
    const vault = makeVault({ supportsWrite: true, supportsRefresh: true });
    const result = await tool.execute(
      { path: 'notes/test.md', content: '# Hello' },
      makeContext([vault]),
    );

    expect(result.isError).toBeFalsy();
    expect(vault.reindexFile).toHaveBeenCalledWith('notes/test.md');
    expect(vault.regenerateCanvas).toHaveBeenCalled();
  });

  it('returns error when no vaults registered', async () => {
    const result = await tool.execute(
      { path: 'a.md', content: 'x' },
      makeContext([]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no vaults registered/);
  });

  it('returns error when path is missing', async () => {
    const result = await tool.execute(
      { content: 'x' },
      makeContext([makeVault()]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/path.*required/);
  });

  it('scopes to explicit vaultId', async () => {
    const v1 = makeVault({ id: 'v1', supportsWrite: true });
    const v2 = makeVault({ id: 'v2', supportsWrite: true });
    const result = await tool.execute(
      { path: 'a.md', content: 'x', vaultId: 'v2' },
      makeContext([v1, v2]),
    );
    expect(result.content).toContain('v2');
    expect(v1.writeFile).not.toHaveBeenCalled();
    expect(v2.writeFile).toHaveBeenCalled();
  });

  it('reports vaults that do not support writeFile', async () => {
    const v1 = makeVault({ supportsWrite: false });
    const result = await tool.execute(
      { path: 'a.md', content: 'x' },
      makeContext([v1]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/writeFile not supported/);
  });
});
