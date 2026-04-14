import { describe, it, expect, vi } from 'vitest';
import { applyWriteHookToToolResult } from '../../src/agents/orchestrator.js';

describe('applyWriteHookToToolResult', () => {
  it('invokes hook for Edit tool with path output', async () => {
    const after = vi.fn(async (_p: string) => null);
    const res: any = { toolName: 'Edit', output: { path: '/proj/Assets/Player.cs', ok: true } };
    await applyWriteHookToToolResult(res, { afterWrite: after } as any);
    expect(after).toHaveBeenCalledWith('/proj/Assets/Player.cs');
  });

  it('skips when hook is null', async () => {
    await expect(applyWriteHookToToolResult({ toolName: 'Read' } as any, null)).resolves.not.toThrow();
  });

  it('appends warning when hook returns non-null', async () => {
    const after = vi.fn(async () => 'vault may be stale for X');
    const res: any = { toolName: 'Write', output: { path: '/proj/a.cs' }, warnings: [] };
    await applyWriteHookToToolResult(res, { afterWrite: after } as any);
    expect(res.warnings).toContain('vault may be stale for X');
  });

  it('ignores non-Edit/Write tool names', async () => {
    const after = vi.fn();
    await applyWriteHookToToolResult({ toolName: 'Read', output: { path: '/a' } } as any, { afterWrite: after } as any);
    expect(after).not.toHaveBeenCalled();
  });
});
