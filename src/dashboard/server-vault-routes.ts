import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { isAbsolute as isAbsolutePath } from 'node:path';
import type { VaultRegistry } from '../vault/vault-registry.js';
import type { IVault, VaultQuery } from '../vault/vault.interface.js';
import { getVaultFileReadStats } from '../agents/tools/file-read.js';
import { getLoggerSafe } from '../utils/logger.js';
import type { IAIProvider } from '../agents/providers/provider.interface.js';
import { sendJson, sendJsonError, type RouteContext } from './server-types.js';
import { summarizeSymbol } from '../vault/symbol-summarizer.js';
import { resolveExistingVaultRoot } from '../vault/path-policy.js';
import { VaultQueryError } from '../vault/obsidian-vault.js';

/**
 * Factory injected by bootstrap so the HTTP layer can create a new vault
 * instance on POST /api/vaults without reaching into VaultRegistry internals.
 * Captures the `embedding` + `vectorStore` deps that were otherwise bootstrap-local.
 */
export interface VaultFactory {
  create(spec: { id: string; rootPath: string; kind: 'unity' | 'generic' }): Promise<IVault>;
  /** Optional: default debounce in ms passed to `startWatch`. */
  watchDebounceMs?: number;
}

const VAULT_NAME_RE = /^[A-Za-z0-9 _\-.]{1,64}$/;
const MAX_ROOT_PATH_LEN = 1024;

function validateVaultRegisterBody(body: Record<string, unknown>): {
  ok: true; name: string; rootPath: string; kind: 'unity' | 'generic';
} | { ok: false; error: string } {
  const rawName = body.name;
  const rawPath = body.rootPath;
  const rawKind = body.kind ?? 'generic';
  if (typeof rawName !== 'string' || !VAULT_NAME_RE.test(rawName)) {
    return { ok: false, error: 'invalid name' };
  }
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_ROOT_PATH_LEN) {
    return { ok: false, error: 'invalid rootPath' };
  }
  if (!isAbsolutePath(rawPath)) {
    return { ok: false, error: 'rootPath must be absolute' };
  }
  if (rawPath.includes('\x00')) {
    return { ok: false, error: 'invalid rootPath' };
  }
  if (rawKind !== 'unity' && rawKind !== 'generic') {
    return { ok: false, error: 'invalid kind' };
  }
  return { ok: true, name: rawName.trim(), rootPath: rawPath, kind: rawKind };
}

/**
 * Resolve + validate that `rootPath` exists as a directory. Returns canonical
 * realpath on success. Rejects any path whose realpath cannot be resolved
 * (non-existent, unreadable, or symlink loop).
 */
async function resolveExistingDirectory(rootPath: string): Promise<
  { ok: true; realPath: string } | { ok: false; error: string }
> {
  return resolveExistingVaultRoot(rootPath);
}

function makeVaultId(kind: 'unity' | 'generic', rootPath: string): string {
  const hash = createHash('sha1').update(rootPath).digest('hex').slice(0, 8);
  return `${kind}:${hash}`;
}

/**
 * Express-shaped req/res for `registerVaultRoutes` (dev-server/test adapter; production
 * uses the raw Node http path via `handleVaultRoutes`). A full `IncomingMessage &
 * { params; query; body }` typing fights noUncheckedIndexedAccess on every handler
 * access; the tradeoff isn't worth a lint-only win. The raw-http `handleVaultRoutes`
 * path (production) IS strictly typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExpressLikeReq = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExpressLikeRes = any;

export interface RouteApp {
  get(path: string, handler: (req: ExpressLikeReq, res: ExpressLikeRes) => unknown): void;
  post(path: string, handler: (req: ExpressLikeReq, res: ExpressLikeRes) => unknown): void;
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

function coercePositiveInteger(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function coerceStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  return values.length > 0 ? values : undefined;
}

function buildVaultSearchQuery(body: Record<string, unknown>): VaultQuery | { error: string } {
  const rawText = body.text;
  if (typeof rawText !== 'string') return { error: 'invalid text' };
  const text = rawText.slice(0, MAX_QUERY_TEXT_CHARS);
  const topK = coerceTopK(body.topK);
  const budgetTokens = coercePositiveInteger(body.budgetTokens);
  const langFilter = coerceStringArray(body.langFilter) as VaultQuery['langFilter'] | undefined;
  const pathGlob = typeof body.pathGlob === 'string' && body.pathGlob.trim().length > 0
    ? body.pathGlob.trim()
    : undefined;
  const focusFiles = coerceStringArray(body.focusFiles);
  return {
    text,
    topK,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(langFilter !== undefined ? { langFilter } : {}),
    ...(pathGlob !== undefined ? { pathGlob } : {}),
    ...(focusFiles !== undefined ? { focusFiles } : {}),
  };
}

/**
 * Point-in-time snapshot of vault retrieval telemetry.
 * Backs `GET /api/vaults/stats` — see Round 2 of the Codebase Memory Vault plan.
 */
export interface VaultRetrievalStatsSnapshot {
  fileRead: {
    hits: number;
    misses: number;
    stale: number;
    hitRatePct: number;
  };
  timestamp: string;
}

export function buildVaultRetrievalStatsSnapshot(
  stats: Readonly<{ hits: number; misses: number; stale: number }> = getVaultFileReadStats(),
  now: Date = new Date(),
): VaultRetrievalStatsSnapshot {
  const denom = stats.hits + stats.misses;
  const hitRatePct = denom === 0 ? 0 : (stats.hits / denom) * 100;
  return {
    fileRead: {
      hits: stats.hits,
      misses: stats.misses,
      stale: stats.stale,
      // Round to 2 decimals so clients get stable, display-friendly values.
      hitRatePct: Math.round(hitRatePct * 100) / 100,
    },
    timestamp: now.toISOString(),
  };
}

export function registerVaultRoutes(app: RouteApp, registry: VaultRegistry, factory?: VaultFactory, llmProvider?: IAIProvider): void {
  // Fix SecC2: do NOT expose absolute rootPath. Clients get id + kind only.
  app.get('/api/vaults', () => ({
    items: registry.list().map((v) => ({ id: v.id, kind: v.kind })),
  }));

  app.post('/api/vaults', async (req) => {
    if (!factory) {
      return {
        error: 'VaultFactory not installed (bootstrap ordering issue or embedding provider missing)',
      };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = validateVaultRegisterBody(body);
    if (!parsed.ok) return { error: parsed.error };
    const dirCheck = await resolveExistingDirectory(parsed.rootPath);
    if (!dirCheck.ok) return { error: dirCheck.error };
    const id = makeVaultId(parsed.kind, dirCheck.realPath);
    if (registry.get(id)) return { error: 'vault already registered' };
    const vault = await factory.create({ id, rootPath: dirCheck.realPath, kind: parsed.kind });
    registry.register(vault);
    void vault.init().catch((err) => getLoggerSafe().warn('[vault] async init failed', { err }));
    return {
      id: vault.id, name: parsed.name,
      kind: vault.kind, status: 'indexing', symbolCount: 0,
    };
  });

  // Round 2: expose vault_search vs file_read retrieval telemetry.
  app.get('/api/vaults/stats', () => buildVaultRetrievalStatsSnapshot());

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
    const query = buildVaultSearchQuery((req.body ?? {}) as Record<string, unknown>);
    if ('error' in query) return { error: query.error };
    try {
      return await v.query(query);
    } catch (err) {
      if (err instanceof VaultQueryError) {
        // P2 fix: surface typed query errors (e.g. empty FTS) as 4xx-style payloads.
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  app.post('/api/vaults/:id/sync', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    const result = await v.sync();
    return sanitizeSyncResponse(result);
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

  app.get('/api/vaults/:id/notes/:path/backlinks', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    const notePath = String(req.params.path ?? '');
    if (isUnsafePath(notePath)) return { error: 'invalid path' };
    return (await v.listBacklinks?.(notePath)) ?? { wikilinks: [], callers: [] };
  });

  app.post('/api/vaults/:id/symbols/:symbolId/summarize', async (req) => {
    const v = registry.get(req.params.id);
    if (!v) return { error: 'not found' };
    const symbolId = String(req.params.symbolId ?? '');
    if (!symbolId || symbolId.length > 1024) return { error: 'invalid symbol id' };
    if (!llmProvider) return { error: 'LLM provider not available' };

    const symbols = await v.findSymbolsByName?.(symbolId.split('::').pop() ?? symbolId, 20) ?? [];
    const symbol = symbols.find((s) => s.symbolId === symbolId);
    if (!symbol) return { error: 'symbol not found' };

    const summary = await summarizeSymbol(
      { provider: llmProvider },
      symbol,
      (path) => v.readFile!(path),
    );
    return { summary };
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
    sendJson(res, {
      items: registry.list().map((v) => ({
        id: v.id,
        kind: v.kind,
        // Intentionally do NOT expose v.rootPath — callers only need the id.
      })),
    });
    return true;
  }

  // POST /api/vaults — register + index a new vault at runtime.
  // Guarded by the VaultFactory that bootstrap installs; without one the subsystem
  // wasn't primed with an embedding provider, so we can't build a vault.
  if (pathOnly === '/api/vaults' && method === 'POST') {
    const factory = ctx.vaultFactory;
    if (!factory) {
      // More diagnostic than the old "vault registration unavailable" — a 503 here
      // almost always means the bootstrap ran before cachedEmbeddingProvider was
      // ready, or ran with no embedding provider at all. Surface that to the
      // caller so ops doesn't have to grep logs to figure out which branch failed.
      sendJsonError(
        res,
        503,
        'VaultFactory not installed (bootstrap ordering issue or embedding provider missing)',
      );
      return true;
    }
    void readJsonBody(req).then(async (body) => {
      const parsed = validateVaultRegisterBody(body);
      if (!parsed.ok) { sendJsonError(res, 400, parsed.error); return; }
      const dirCheck = await resolveExistingDirectory(parsed.rootPath);
      if (!dirCheck.ok) { sendJsonError(res, 400, dirCheck.error); return; }
      const id = makeVaultId(parsed.kind, dirCheck.realPath);
      if (registry.get(id)) { sendJsonError(res, 409, 'vault already registered'); return; }
      try {
        const vault = await factory.create({ id, rootPath: dirCheck.realPath, kind: parsed.kind });
        // Register synchronously so the vault appears in GET /api/vaults immediately,
        // then kick off indexing in the background — init() can take a while on large repos.
        registry.register(vault);
        sendJson(res, {
          id: vault.id,
          name: parsed.name,
          kind: vault.kind,
          status: 'indexing',
          symbolCount: 0,
        }, 201);
        // Fire-and-log init + watch so we don't block the HTTP response.
        void (async () => {
          try {
            await vault.init();
            // Best-effort watcher start; UnityProjectVault exposes startWatch,
            // SelfVault does not, so duck-type the call.
            const maybeWatcher = (vault as unknown as { startWatch?: (ms: number) => Promise<void> });
            if (typeof maybeWatcher.startWatch === 'function') {
              await maybeWatcher.startWatch(factory.watchDebounceMs ?? 800);
            }
          } catch (err) {
            getLoggerSafe().warn(`[vault] async init failed for ${id}`, { err });
          }
        })();
      } catch (err) {
        getLoggerSafe().warn('[vault] registration failed', { err });
        sendJsonError(res, 500, 'registration failed');
      }
    }).catch(() => sendJsonError(res, 500, 'registration failed'));
    return true;
  }

  // DELETE /api/vaults/:id — unregister + dispose a vault.
  const deleteMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const id = decodeURIComponent(deleteMatch[1]!);
    const vault = registry.get(id);
    if (!vault) { sendJsonError(res, 404, 'vault not found'); return true; }
    registry.unregister(id);
    void vault.dispose().catch((err) => getLoggerSafe().warn(`[vault] dispose failed for ${id}`, { err }));
    sendJson(res, { ok: true, id });
    return true;
  }

  // Round 2: GET /api/vaults/stats — retrieval telemetry snapshot.
  // sec-M2: unauth GET is intentional, matches other /api/vaults/* GETs;
  // server is 127.0.0.1 bound.
  if (pathOnly === '/api/vaults/stats' && method === 'GET') {
    sendJson(res, buildVaultRetrievalStatsSnapshot());
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

  // POST /api/vaults/:id/regenerate-canvas — force canvas rebuild
  const regenCanvasMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/regenerate-canvas$/);
  if (regenCanvasMatch && method === 'POST') {
    const vv = registry.get(decodeURIComponent(regenCanvasMatch[1]!));
    if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
    void Promise.resolve(vv.regenerateCanvas?.())
      .then(() => sendJson(res, { ok: true }))
      .catch(() => sendJsonError(res, 500, 'regenerate failed'));
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

  // Symbol summary: /api/vaults/:id/symbols/:symbolId/summarize
  const summarizeMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/symbols\/(.+)\/summarize$/);
  if (summarizeMatch && method === 'POST') {
    const vv = registry.get(decodeURIComponent(summarizeMatch[1]!));
    if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
    const symbolId = decodeURIComponent(summarizeMatch[2]!);
    if (!symbolId || symbolId.length > 1024) { sendJsonError(res, 400, 'invalid symbol id'); return true; }
    if (!ctx.llmProvider) { sendJsonError(res, 503, 'LLM provider not available'); return true; }

    void Promise.resolve(vv.findSymbolsByName?.(symbolId.split('::').pop() ?? symbolId, 20) ?? [])
      .then(async (symbols) => {
        const symbol = symbols.find((s) => s.symbolId === symbolId);
        if (!symbol) { sendJsonError(res, 404, 'symbol not found'); return; }

        const summary = await summarizeSymbol(
          { provider: ctx.llmProvider! },
          symbol,
          (path) => vv.readFile!(path),
        );
        sendJson(res, { summary });
      })
      .catch(() => sendJsonError(res, 500, 'summarize failed'));
    return true;
  }

  // Wikilink backlinks: /api/vaults/:id/notes/:path/backlinks
  const backlinksMatch = pathOnly.match(/^\/api\/vaults\/([^/]+)\/notes\/(.+)\/backlinks$/);
  if (backlinksMatch && method === 'GET') {
    const vv = registry.get(decodeURIComponent(backlinksMatch[1]!));
    if (!vv) { sendJsonError(res, 404, 'vault not found'); return true; }
    const notePath = decodeURIComponent(backlinksMatch[2]!);
    if (isUnsafePath(notePath)) { sendJsonError(res, 400, 'invalid path'); return true; }
    void Promise.resolve(vv.listBacklinks?.(notePath) ?? { wikilinks: [], callers: [] })
      .then((result) => sendJson(res, result))
      .catch(() => sendJsonError(res, 500, 'backlinks failed'));
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
    void readJsonBody(req).then(async (body) => {
      const rawText = body?.text;
      if (typeof rawText !== 'string') { sendJsonError(res, 400, 'invalid text'); return; }
      const query = buildVaultSearchQuery(body ?? {});
      if ('error' in query) { sendJsonError(res, 400, query.error); return; }
      try {
        const result = await vault.query(query);
        sendJson(res, result);
      } catch (err) {
        if (err instanceof VaultQueryError) {
          // P2 fix: surface typed query errors as HTTP 400 with code.
          sendJsonError(res, 400, err.message);
          return;
        }
        throw err;
      }
    }).catch(() => sendJsonError(res, 500, 'search failed'));
    return true;
  }
  if (op === 'sync' && method === 'POST') {
    void vault.sync()
      .then((r) => sendJson(res, sanitizeSyncResponse(r)))
      .catch(() => sendJsonError(res, 500, 'sync failed'));
    return true;
  }

  return false;
}

// Fix phase2-review C1: cap body bytes to prevent DoS via unbounded POST bodies.
// Mirrors DashboardServer.readJsonBody default (4 KiB is enough for a search query).
const MAX_BODY_BYTES = 4096;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      return {};
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    // sec-L1: JSON.parse can return null/primitives/arrays; narrow to plain object
    // so the Promise<Record<string, unknown>> return type is honest at runtime.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ALLOWLIST: future fields on the vault sync result must be added here AND to
// `sanitizeSyncResponse` below — spreading the upstream object would silently
// leak any new top-level field (e.g. an internal `error` or `path`).
type SafeSyncResponse = {
  changed: number;
  durationMs: number;
  canvas?: { ok: true } | { ok: false; error: 'canvas regeneration failed' };
};

/**
 * Defense-in-depth for SecH1: even though the vault layer already redacts
 * absolute paths from `canvas.error`, the HTTP response must never leak the
 * raw failure string. We replace it with a stable generic message and keep
 * only the boolean `ok` flag for clients. Internal logs (which can contain
 * the original message) are unaffected. Returns `null` when the input isn't
 * a plain object — callers must handle that explicitly.
 */
function sanitizeSyncResponse(result: unknown): SafeSyncResponse | null {
  if (!result || typeof result !== 'object') return null;
  const x = result as Record<string, unknown>;
  const changed = typeof x.changed === 'number' ? x.changed : 0;
  const durationMs = typeof x.durationMs === 'number' ? x.durationMs : 0;
  const out: SafeSyncResponse = { changed, durationMs };
  const canvas = x.canvas;
  if (canvas && typeof canvas === 'object' && 'ok' in canvas) {
    const ok = (canvas as { ok: unknown }).ok;
    out.canvas = ok === false
      ? { ok: false, error: 'canvas regeneration failed' }
      : { ok: true };
  }
  return out;
}

export interface WsBroadcaster { broadcast(msg: string): void; }

export function wireVaultUpdatesToWs(registry: VaultRegistry, wss: WsBroadcaster): () => void {
  const offs = new Map<string, () => void>();
  const attach = (v: IVault): void => {
    offs.get(v.id)?.();
    const off = v.onUpdate((payload) => {
      // Fix I2: swallow broadcast errors so a single bad client doesn't break the listener.
      try {
        wss.broadcast(JSON.stringify({ type: 'vault:update', payload }));
      } catch (err) {
        getLoggerSafe().warn('[vault] WS broadcast failed', { err });
      }
    });
    offs.set(v.id, off);
  };
  for (const v of registry.list()) attach(v);
  const offRegister = typeof registry.onRegister === 'function'
    ? registry.onRegister((vault) => attach(vault))
    : () => undefined;
  return () => {
    offRegister();
    for (const off of offs.values()) off();
    offs.clear();
  };
}
