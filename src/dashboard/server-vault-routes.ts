import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VaultRegistry } from '../vault/vault-registry.js';
import { getLoggerSafe } from '../utils/logger.js';
import { sendJson, sendJsonError, type RouteContext } from './server-types.js';

export interface RouteApp {
  get(path: string, handler: (req: any, res: any) => any): void;
  post(path: string, handler: (req: any, res: any) => any): void;
}

const MAX_QUERY_TEXT_CHARS = 4096;
const MAX_TOP_K = 100;
const DEFAULT_TOP_K = 20;

// Fix SecC1 defense-in-depth at the HTTP layer: reject path-traversal attempts
// before they reach IVault.readFile (which also enforces confinement).
function isUnsafePath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0) return true;
  if (p.length > 1024) return true;
  // Block absolute, parent refs, null bytes, backslashes, URL-encoded dots.
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  if (p.includes('..')) return true;
  if (p.includes('\x00')) return true;
  if (/%2e%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p)) return true;
  return false;
}

function coerceTopK(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_K;
  return Math.min(Math.floor(n), MAX_TOP_K);
}

export function registerVaultRoutes(app: RouteApp, registry: VaultRegistry): void {
  // Fix SecC2: do NOT expose absolute rootPath. Clients get id + kind only.
  app.get('/api/vaults', () => ({
    items: registry.list().map((v) => ({ id: v.id, kind: v.kind })),
  }));

  app.get('/api/vaults/:id/stats', async (req) => {
    const v = registry.get(req.params.id);
    return v ? await v.stats() : { error: 'not found' };
  });

  app.get('/api/vaults/:id/tree', (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    return { items: v.listFiles().map((f) => ({ path: f.path, lang: f.lang })) };
  });

  app.get('/api/vaults/:id/file', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    const p = req.query?.path;
    if (isUnsafePath(p)) return { error: 'invalid path' };
    try {
      return { body: await v.readFile(p as string) };
    } catch {
      return { error: 'invalid path' };
    }
  });

  app.post('/api/vaults/:id/search', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    // Fix SecH3: validate text + topK before query.
    const rawText = req.body?.text;
    if (typeof rawText !== 'string') return { error: 'invalid text' };
    const text = rawText.slice(0, MAX_QUERY_TEXT_CHARS);
    const topK = coerceTopK(req.body?.topK);
    return await v.query({ text, topK });
  });

  app.post('/api/vaults/:id/sync', async (req) => {
    const v = registry.get(req.params.id);
    return v ? await v.sync() : { error: 'not found' };
  });

  // Phase 2: graph + symbol endpoints.
  app.get('/api/vaults/:id/canvas', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    return (await v.readCanvas?.()) ?? { nodes: [], edges: [] };
  });

  app.get('/api/vaults/:id/symbols/by-name', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    const q = typeof req.query?.q === 'string' ? req.query.q : '';
    if (!q || q.length > 200) return { error: 'invalid q' };
    const items = (await v.findSymbolsByName?.(q, 20)) ?? [];
    return { items };
  });

  app.get('/api/vaults/:id/symbols/:symbolId/callers', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    const sid = String(req.params.symbolId ?? '');
    if (!sid || sid.length > 1024) return { error: 'invalid symbol id' };
    const items = (await v.findCallers?.(sid)) ?? [];
    return { items };
  });
}

/**
 * DashboardServer handler-pattern adapter for the vault routes.
 * Mirrors handleSkillsRoutes / handleSystemRoutes shape so it can be wired
 * the same way from server.ts. Returns true when the route matched.
 */
export function handleVaultRoutes(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  if (!url.startsWith('/api/vaults')) return false;
  const registry = ctx.vaultRegistry;
  if (!registry) {
    sendJsonError(res, 503, 'vault subsystem not enabled');
    return true;
  }

  const pathOnly = url.split('?')[0]!;
  const u = new URL(url, 'http://localhost');

  // GET /api/vaults
  if (pathOnly === '/api/vaults' && method === 'GET') {
    sendJson(res, { items: registry.list().map((v) => ({ id: v.id, kind: v.kind })) });
    return true;
  }

  // Phase 2: /api/vaults/:id/canvas
  const canvasMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/canvas$/);
  if (canvasMatch && method === 'GET') {
    const vv = registry.get(decodeURIComponent(canvasMatch[1]!));
    if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
    void Promise.resolve(vv.readCanvas?.() ?? { nodes: [], edges: [] })
      .then((c) => sendJson(res, c))
      .catch(() => sendJsonError(res, 500, 'canvas unavailable'));
    return true;
  }

  // Phase 2: /api/vaults/:id/symbols/by-name?q=…
  const byNameMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/symbols\/by-name$/);
  if (byNameMatch && method === 'GET') {
    const vv = registry.get(decodeURIComponent(byNameMatch[1]!));
    if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
    const q = u.searchParams.get('q') ?? '';
    if (!q || q.length > 200) { sendJsonError(res, 400, 'invalid q'); return true; }
    void Promise.resolve(vv.findSymbolsByName?.(q, 20) ?? [])
      .then((items) => sendJson(res, { items }))
      .catch(() => sendJsonError(res, 500, 'by-name failed'));
    return true;
  }

  // Phase 2: /api/vaults/:id/symbols/:symbolId/callers
  const callersMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/symbols\/([^/]+)\/callers$/);
  if (callersMatch && method === 'GET') {
    const vv = registry.get(decodeURIComponent(callersMatch[1]!));
    if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
    const sid = decodeURIComponent(callersMatch[2]!);
    if (!sid || sid.length > 1024) { sendJsonError(res, 400, 'invalid symbol id'); return true; }
    void Promise.resolve(vv.findCallers?.(sid) ?? [])
      .then((items) => sendJson(res, { items }))
      .catch(() => sendJsonError(res, 500, 'callers failed'));
    return true;
  }

  // /api/vaults/:id/{stats,tree,file,search,sync}
  const m = pathOnly.match(/^\/api\/vaults\/([^/]+)\/(stats|tree|file|search|sync)$/);
  if (!m) return false;
  const [, id, op] = m;
  const vault = registry.get(decodeURIComponent(id!));
  if (!vault) { sendJsonError(res, 404, 'vault not found'); return true; }

  if (op === 'stats' && method === 'GET') {
    void vault.stats().then((s) => sendJson(res, s)).catch(() => sendJsonError(res, 500, 'stats failed'));
    return true;
  }
  if (op === 'tree' && method === 'GET') {
    sendJson(res, { items: vault.listFiles().map((f) => ({ path: f.path, lang: f.lang })) });
    return true;
  }
  if (op === 'file' && method === 'GET') {
    const p = u.searchParams.get('path');
    if (isUnsafePath(p)) { sendJsonError(res, 400, 'invalid path'); return true; }
    void vault.readFile(p!).then((body) => sendJson(res, { body }))
      .catch(() => sendJsonError(res, 400, 'invalid path'));
    return true;
  }
  if (op === 'search' && method === 'POST') {
    void readJsonBody(req).then(async (body: { text?: unknown; topK?: unknown }) => {
      const rawText = body?.text;
      if (typeof rawText !== 'string') { sendJsonError(res, 400, 'invalid text'); return; }
      const text = rawText.slice(0, MAX_QUERY_TEXT_CHARS);
      const topK = coerceTopK(body?.topK);
      const result = await vault.query({ text, topK });
      sendJson(res, result);
    }).catch(() => sendJsonError(res, 500, 'search failed'));
    return true;
  }
  if (op === 'sync' && method === 'POST') {
    void vault.sync().then((r) => sendJson(res, r)).catch(() => sendJsonError(res, 500, 'sync failed'));
    return true;
  }

  return false;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export interface WsBroadcaster { broadcast(msg: string): void; }

export function wireVaultUpdatesToWs(registry: VaultRegistry, wss: WsBroadcaster): () => void {
  const offs: Array<() => void> = [];
  for (const v of registry.list()) {
    const off = v.onUpdate((payload) => {
      // Fix I2: swallow broadcast errors so a single bad client doesn't break the listener.
      try {
        wss.broadcast(JSON.stringify({ type: 'vault:update', payload }));
      } catch (err) {
        getLoggerSafe().warn('[vault] WS broadcast failed', { err });
      }
    });
    offs.push(off);
  }
  return () => { for (const off of offs) off(); };
}
