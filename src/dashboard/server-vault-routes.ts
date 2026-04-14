import type { VaultRegistry } from '../vault/vault-registry.js';

export interface RouteApp {
  get(path: string, handler: (req: any, res: any) => any): void;
  post(path: string, handler: (req: any, res: any) => any): void;
}

export function registerVaultRoutes(app: RouteApp, registry: VaultRegistry): void {
  app.get('/api/vaults', () => ({
    items: registry.list().map((v) => ({ id: v.id, kind: v.kind, rootPath: v.rootPath })),
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
    const p: string | undefined = req.query?.path;
    if (!p) return { error: 'missing path' };
    if (p.includes('..') || p.startsWith('/')) return { error: 'invalid path' };
    return { body: await v.readFile(p) };
  });

  app.post('/api/vaults/:id/search', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    return await v.query({ text: req.body?.text ?? '', topK: req.body?.topK ?? 20 });
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
      wss.broadcast(JSON.stringify({ type: 'vault:update', payload }));
    });
    offs.push(off);
  }
  return () => { for (const off of offs) off(); };
}
