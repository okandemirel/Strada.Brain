import { describe, it, expect, vi } from 'vitest';
import { installWriteHook } from '../../src/vault/write-hook.js';

function fakeVault(reindex = vi.fn()) {
  return { id: 'v1', kind: 'unity-project', rootPath: '/proj', reindexFile: reindex } as any;
}

describe('write-hook', () => {
  it('reindexes within budget', async () => {
    const r = vi.fn().mockResolvedValue(true);
    const hook = installWriteHook({ vault: fakeVault(r), budgetMs: 200 });
    await hook.afterWrite('/proj/Assets/A.cs');
    expect(r).toHaveBeenCalledWith('Assets/A.cs');
  });

  it('returns stale warning when budget exceeded', async () => {
    const r = vi.fn(async () => { await new Promise((res) => setTimeout(res, 50)); return true; });
    const hook = installWriteHook({ vault: fakeVault(r), budgetMs: 10 });
    const warn = await hook.afterWrite('/proj/Assets/A.cs');
    expect(warn).toMatch(/vault may be stale/i);
  });

  it('no-ops for paths outside vault root', async () => {
    const r = vi.fn();
    const hook = installWriteHook({ vault: fakeVault(r), budgetMs: 200 });
    await hook.afterWrite('/other/place/a.cs');
    expect(r).not.toHaveBeenCalled();
  });
});
