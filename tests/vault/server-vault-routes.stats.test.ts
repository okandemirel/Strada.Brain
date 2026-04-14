import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildVaultRetrievalStatsSnapshot,
  registerVaultRoutes,
  handleVaultRoutes,
} from '../../src/dashboard/server-vault-routes.js';
import { resetVaultFileReadStats } from '../../src/agents/tools/file-read.js';

function makeFakeApp() {
  const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
  return {
    get: (p: string, h: (req: unknown, res: unknown) => unknown) => {
      routes['GET ' + p] = h;
    },
    post: (p: string, h: (req: unknown, res: unknown) => unknown) => {
      routes['POST ' + p] = h;
    },
    routes,
  };
}

const emptyRegistry = { list: () => [], get: () => undefined } as never;

describe('vault routes — stats endpoint', () => {
  beforeEach(() => {
    resetVaultFileReadStats();
  });

  describe('buildVaultRetrievalStatsSnapshot', () => {
    it('returns zeros and 0% hit rate when no reads have happened', () => {
      const snap = buildVaultRetrievalStatsSnapshot(
        { hits: 0, misses: 0, stale: 0 },
        new Date('2026-04-14T00:00:00.000Z'),
      );
      expect(snap.fileRead.hits).toBe(0);
      expect(snap.fileRead.misses).toBe(0);
      expect(snap.fileRead.stale).toBe(0);
      expect(snap.fileRead.hitRatePct).toBe(0);
      expect(snap.timestamp).toBe('2026-04-14T00:00:00.000Z');
    });

    it('computes hitRatePct = 75 for 3 hits / 1 miss', () => {
      const snap = buildVaultRetrievalStatsSnapshot({ hits: 3, misses: 1, stale: 0 });
      expect(snap.fileRead.hitRatePct).toBe(75);
    });

    it('computes hitRatePct = 100 when there are only hits', () => {
      const snap = buildVaultRetrievalStatsSnapshot({ hits: 5, misses: 0, stale: 2 });
      expect(snap.fileRead.hitRatePct).toBe(100);
      expect(snap.fileRead.stale).toBe(2);
    });

    it('computes hitRatePct = 0 when there are only misses', () => {
      const snap = buildVaultRetrievalStatsSnapshot({ hits: 0, misses: 4, stale: 0 });
      expect(snap.fileRead.hitRatePct).toBe(0);
    });

    it('rounds hitRatePct to 2 decimal places', () => {
      // 1 / 3 => 33.333...% -> 33.33
      const snap = buildVaultRetrievalStatsSnapshot({ hits: 1, misses: 2, stale: 0 });
      expect(snap.fileRead.hitRatePct).toBe(33.33);
    });

    it('produces a valid ISO 8601 timestamp', () => {
      const snap = buildVaultRetrievalStatsSnapshot({ hits: 0, misses: 0, stale: 0 });
      expect(() => new Date(snap.timestamp).toISOString()).not.toThrow();
      expect(snap.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('registerVaultRoutes /api/vaults/stats', () => {
    it('registers GET /api/vaults/stats', () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as never, emptyRegistry);
      expect(app.routes['GET /api/vaults/stats']).toBeTypeOf('function');
    });

    it('returns snapshot shape from the registered handler', async () => {
      const app = makeFakeApp();
      registerVaultRoutes(app as never, emptyRegistry);
      const handler = app.routes['GET /api/vaults/stats']!;
      const result = (await handler({}, {})) as {
        fileRead: { hits: number; misses: number; stale: number; hitRatePct: number };
        timestamp: string;
      };
      expect(result.fileRead).toMatchObject({ hits: 0, misses: 0, stale: 0, hitRatePct: 0 });
      expect(result.timestamp).toEqual(expect.any(String));
    });
  });

  describe('handleVaultRoutes /api/vaults/stats', () => {
    function makeFakeRes() {
      const captured: { status?: number; body?: string; headers: Record<string, string> } = {
        headers: {},
      };
      const res = {
        statusCode: 200,
        setHeader(k: string, v: string) {
          captured.headers[k] = v;
        },
        writeHead(status: number, headers?: Record<string, string>) {
          captured.status = status;
          if (headers) Object.assign(captured.headers, headers);
        },
        end(chunk?: string) {
          captured.body = chunk ?? '';
        },
        getHeader(k: string) {
          return captured.headers[k];
        },
      };
      return { res, captured };
    }

    it('matches the URL and returns 200 with snapshot JSON', () => {
      const registry = { list: () => [], get: () => undefined } as never;
      const { res, captured } = makeFakeRes();
      const handled = handleVaultRoutes(
        '/api/vaults/stats',
        'GET',
        {} as never,
        res as never,
        { vaultRegistry: registry } as never,
      );
      expect(handled).toBe(true);
      expect(captured.body).toBeDefined();
      const json = JSON.parse(captured.body!);
      expect(json.fileRead).toMatchObject({ hits: 0, misses: 0, stale: 0, hitRatePct: 0 });
      expect(json.timestamp).toEqual(expect.any(String));
    });

    it('returns 503 when vault subsystem is disabled', () => {
      const { res, captured } = makeFakeRes();
      const handled = handleVaultRoutes(
        '/api/vaults/stats',
        'GET',
        {} as never,
        res as never,
        {} as never,
      );
      expect(handled).toBe(true);
      expect(captured.status).toBe(503);
    });
  });
});
