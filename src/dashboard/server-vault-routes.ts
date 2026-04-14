import type { VaultRegistry } from '../vault/vault-registry.js';

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
        console.warn('[vault] WS broadcast failed:', err);
      }
    });
    offs.push(off);
  }
  return () => { for (const off of offs) off(); };
}
