import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireVaultUpdatesToWs } from '../../src/dashboard/server-vault-routes.js';

describe('vault:update WS broadcast', () => {
  it('broadcasts when a vault emits update', () => {
    const send = vi.fn();
    const wss = { broadcast: (m: string) => send(m) };
    const vault: any = new EventEmitter();
    vault.id = 'unity:abc';
    vault.onUpdate = (cb: any) => { vault.on('update', cb); return () => vault.off('update', cb); };
    const registry = { list: () => [vault] } as any;
    wireVaultUpdatesToWs(registry, wss);
    vault.emit('update', { vaultId: 'unity:abc', changedPaths: ['a.cs'] });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(send.mock.calls[0][0]);
    expect(msg.type).toBe('vault:update');
    expect(msg.payload.changedPaths).toEqual(['a.cs']);
  });

  it('returns an unsubscribe function', () => {
    const send = vi.fn();
    const wss = { broadcast: (m: string) => send(m) };
    const vault: any = new EventEmitter();
    vault.id = 'v1';
    vault.onUpdate = (cb: any) => { vault.on('update', cb); return () => vault.off('update', cb); };
    const registry = { list: () => [vault] } as any;
    const off = wireVaultUpdatesToWs(registry, wss);
    off();
    vault.emit('update', { vaultId: 'v1', changedPaths: ['x'] });
    expect(send).not.toHaveBeenCalled();
  });
});
