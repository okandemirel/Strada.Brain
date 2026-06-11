import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVaultRoutes, resetVaultSearchRateLimiterForTests } from './server-vault-routes.js';
import type { RouteContext } from './server-types.js';

function makeReq(body?: unknown, remoteAddress = '127.0.0.1'): IncomingMessage {
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const stream = Readable.from(chunks);
  return Object.assign(stream, {
    socket: { remoteAddress },
    headers: {},
  }) as unknown as IncomingMessage;
}

interface StubRes {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeRes(): StubRes {
  return { writeHead: vi.fn(), end: vi.fn() };
}

function asRes(res: StubRes): ServerResponse {
  return res as unknown as ServerResponse;
}

describe('handleVaultRoutes', () => {
  const stubVault = {
    id: 'x',
    kind: 'generic',
    query: vi.fn(async () => ({ results: [] })),
    readFile: vi.fn(async () => 'file body'),
    listFiles: () => [],
  };
  const ctx = {
    vaultRegistry: {
      get: () => stubVault,
      list: () => [stubVault],
    },
  } as unknown as RouteContext;

  beforeEach(() => {
    stubVault.query.mockClear();
    stubVault.readFile.mockClear();
    resetVaultSearchRateLimiterForTests();
  });

  describe('POST /api/vaults/:id/search rate limiting', () => {
    it('returns 429 once the per-source limit is exhausted', async () => {
      resetVaultSearchRateLimiterForTests(2, 10_000);

      for (let i = 0; i < 2; i++) {
        const res = makeRes();
        const handled = handleVaultRoutes('/api/vaults/x/search', 'POST', makeReq({ text: 'hi' }), asRes(res), ctx);
        expect(handled).toBe(true);
        await new Promise(setImmediate);
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      }

      const res = makeRes();
      const handled = handleVaultRoutes('/api/vaults/x/search', 'POST', makeReq({ text: 'hi' }), asRes(res), ctx);
      expect(handled).toBe(true);
      await new Promise(setImmediate);
      expect(res.writeHead).toHaveBeenCalledWith(429, { 'Content-Type': 'application/json' });
      expect(String(res.end.mock.calls[0]?.[0])).toContain('rate limit exceeded');
    });

    it('isolates limits per source address', async () => {
      resetVaultSearchRateLimiterForTests(2, 10_000);

      for (let i = 0; i < 2; i++) {
        const res = makeRes();
        handleVaultRoutes('/api/vaults/x/search', 'POST', makeReq({ text: 'hi' }), asRes(res), ctx);
        await new Promise(setImmediate);
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      }

      // Third request from a DIFFERENT source is still allowed.
      const res = makeRes();
      const handled = handleVaultRoutes('/api/vaults/x/search', 'POST', makeReq({ text: 'hi' }, '10.0.0.9'), asRes(res), ctx);
      expect(handled).toBe(true);
      await new Promise(setImmediate);
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    });
  });

  describe('GET /api/vaults/:id/file path validation', () => {
    it('rejects URL-encoded null bytes in the path with 400', async () => {
      const res = makeRes();
      // %2500 in the URL decodes to a literal "%00" in the query value.
      const handled = handleVaultRoutes('/api/vaults/x/file?path=%2500evil.md', 'GET', makeReq(), asRes(res), ctx);
      expect(handled).toBe(true);
      await new Promise(setImmediate);
      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      expect(stubVault.readFile).not.toHaveBeenCalled();
    });

    it('accepts a normal relative path and reaches the vault', async () => {
      const res = makeRes();
      const handled = handleVaultRoutes('/api/vaults/x/file?path=notes/readme.md', 'GET', makeReq(), asRes(res), ctx);
      expect(handled).toBe(true);
      await new Promise(setImmediate);
      expect(stubVault.readFile).toHaveBeenCalledWith('notes/readme.md');
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    });
  });
});
