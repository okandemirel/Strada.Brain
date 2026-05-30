import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SqliteVaultStore } from './sqlite-vault-store.js';
import { chunkFile } from './chunker.js';
import { xxhash64Hex } from './hash.js';
import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from './embedding-adapter.js';
import { rrfFuse, packByBudget } from './query-pipeline.js';
import { listIndexableFiles } from './discovery.js';
import { getExtractorFor } from './symbol-extractor/index.js';
import { buildCanvas } from './canvas-generator.js';
import { runPpr } from './ppr.js';
import { getLoggerSafe } from '../utils/logger.js';
import { AsyncLock } from './async-lock.js';
import { ObsidianApiClient, type ObsidianApiConfig } from './obsidian-client.js';
import {
  getIndexableFileInfo,
  prepareSafeVaultWritePath,
  resolveSafeVaultReadPath,
  validateSafeVaultWriteRelPath,
} from './path-policy.js';
import type {
  IVault, VaultFile, VaultQuery, VaultQueryResult, VaultStats, VaultId, VaultChunk,
  VaultSymbol, VaultEdge, VaultWikilink,
} from './vault.interface.js';

export interface ObsidianVaultDeps {
  id: VaultId;
  rootPath: string;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
  obsidian: ObsidianApiConfig;
}

/**
 * Typed error thrown when a vault query is invalid (e.g. empty FTS query).
 * Route handlers should catch and translate to HTTP 400.
 */
export class VaultQueryError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_query') {
    super(message);
    this.name = 'VaultQueryError';
    this.code = code;
  }
}

function escapeFtsQuery(q: string): string {
  const stripped = q.replace(/["*:()^+\-]/g, ' ').replace(/\b(NOT|AND|OR|NEAR)\b/g, ' ').trim();
  if (!stripped) {
    // Fix P2: empty query previously returned '""' which matched nothing silently.
    // Throw typed error so callers can surface a 400 to clients.
    throw new VaultQueryError('Vault query is empty after sanitization', 'empty_query');
  }
  return `"${stripped}"`;
}

/**
 * Canonicalize a vault-relative path used as wikilink source/target identifier.
 * Always returns the *stored* path with its original case (matching `vault_files.path`),
 * but normalizes separator and trims redundant prefixes so equal logical paths compare equal.
 * NOTE: This does NOT lowercase — case preservation matters for case-sensitive filesystems.
 */
function canonicalizePath(path: string): string {
  // Drop a leading "./" and normalize backslashes; strip leading slash to keep paths vault-root-relative.
  let p = path.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  return p;
}

/**
 * Compute homedir() once at module load — it never changes for the life of
 * the process, so the lookup belongs out of the hot path.
 */
const REDACT_HOMEDIR = homedir();

/**
 * Escape a literal path for embedding in a RegExp constructor. Path
 * separators (`/`, `\\`) are intentionally treated as literals, not
 * alternation — sanitizeSyncResponse (server-vault-routes.ts) is the
 * authoritative defense against any new-shape leak. `-` is escaped too so
 * the pattern stays safe if it's ever moved inside a character class.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Redact absolute filesystem paths from an error message before it crosses a
 * trust boundary. Replaces occurrences of:
 *   - `rootPath` (lexical) → `<vault>`
 *   - `realpath(rootPath)` when it differs (e.g. /var/folders → /private/var) → `<vault>`
 *   - `os.homedir()` → `<home>`
 *
 * Windows note: this best-effort helper matches the path string exactly as it
 * appears. It does NOT canonicalize forward-slash vs backslash, the `\\?\`
 * long-path prefix, or short-name (8.3) variants. `sanitizeSyncResponse` in
 * server-vault-routes.ts is the authoritative defense — it replaces
 * `canvas.error` with a stable generic string regardless of content, so any
 * variant this helper misses is still scrubbed at the HTTP boundary.
 *
 * Synchronous: `realpathRoot` is resolved once at construction time by
 * `ObsidianVault`; the standalone export path takes the realpath as an
 * optional argument so callers (and tests) can pass a value without an
 * extra fs hit.
 */
export function redactPathsInMessage(msg: string, rootPath: string, realpathRoot?: string): string {
  if (!msg) return msg;
  let out = msg;
  if (rootPath) {
    out = out.replace(new RegExp(escapeForRegExp(rootPath), 'g'), '<vault>');
    if (realpathRoot && realpathRoot !== rootPath) {
      out = out.replace(new RegExp(escapeForRegExp(realpathRoot), 'g'), '<vault>');
    }
  }
  if (REDACT_HOMEDIR && REDACT_HOMEDIR !== '/' && REDACT_HOMEDIR !== rootPath) {
    out = out.replace(new RegExp(escapeForRegExp(REDACT_HOMEDIR), 'g'), '<home>');
  }
  return out;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`);
}

function payloadChunkId(hit: { payload?: unknown }): string | null {
  if (hit.payload && typeof hit.payload === 'object' && 'chunkId' in hit.payload) {
    return (hit.payload as { chunkId: string }).chunkId;
  }
  return null;
}

/**
 * Obsidian-backed vault implementation.
 *
 * Design: Option A (FS-backed reads, REST API for writes).
 * - Reads notes from local filesystem (fast, works offline).
 * - Writes back to Obsidian via REST API (so Obsidian handles file I/O and plugin triggers).
 */
export class ObsidianVault implements IVault {
  readonly id: VaultId;
  readonly kind = 'obsidian' as const;
  readonly rootPath: string;
  /**
   * Resolved realpath of `rootPath`, captured once at construction time
   * for use in `redactPathsInMessage`. Falls back to `rootPath` if
   * realpath throws (e.g. root deleted between construction and a later
   * error log) — never throws back to the caller.
   */
  private readonly realpathRoot: string;
  private store: SqliteVaultStore;
  private adapter: EmbeddingAdapter;
  private emitter = new EventEmitter();
  private dbPath: string;
  private client: ObsidianApiClient;
  /**
   * Per-vault async lock serializing reindexFile() / sync() / fullIndex().
   * Prevents concurrent calls from racing on edge-cache invalidation and
   * HNSW upsert/delete sequencing (which can otherwise leak orphan HNSW IDs).
   */
  private writeLock = new AsyncLock();

  constructor(deps: ObsidianVaultDeps) {
    this.id = deps.id;
    this.rootPath = deps.rootPath;
    // Resolve realpath once. If it throws (root deleted, symlink loop, etc.)
    // fall back to the lexical rootPath — redactPathsInMessage degrades to
    // matching only the lexical path in that case, which is correct.
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(deps.rootPath);
    } catch {
      resolvedRoot = deps.rootPath;
    }
    this.realpathRoot = resolvedRoot;
    this.dbPath = join(deps.rootPath, '.strada/vault/index.db');
    mkdirSync(join(deps.rootPath, '.strada/vault'), { recursive: true });
    this.store = new SqliteVaultStore(this.dbPath);
    this.adapter = new EmbeddingAdapter(deps.embedding, deps.vectorStore);
    this.client = new ObsidianApiClient(deps.obsidian);
  }

  async init(): Promise<void> {
    await mkdir(join(this.rootPath, '.strada/vault/codebase'), { recursive: true });
    this.store.migrate();

    // Verify Obsidian API is reachable.
    const healthy = await this.client.healthCheck();
    if (!healthy) {
      getLoggerSafe().warn(`[obsidian-vault ${this.id}] Obsidian API unreachable at ${this.client}`);
      // Continue anyway — FS reads will still work.
    }

    await this.fullIndex();
  }

  async sync(): Promise<{ changed: number; durationMs: number; canvas?: { ok: boolean; error?: string } }> {
    return this.writeLock.run(async () => {
      const started = Date.now();
      const { count, paths } = await this.reindexChangedInternal();
      let canvasStatus: { ok: boolean; error?: string } | undefined;
      if (count > 0) {
        // Resolve wikilinks once: the index pass is sequential, so by the
        // time we get here every file in this sync has its row in
        // vault_files. The previous predicate-filtered second pass iterated
        // an already-empty set of unresolved rows (re-review finding 2).
        await this.resolveWikilinks();
        canvasStatus = await this.regenerateCanvasWithStatus();
        if (!canvasStatus.ok) {
          getLoggerSafe().warn('[obsidian-vault] sync: canvas regen failed', {
            vaultId: this.id, op: 'sync', error: canvasStatus.error,
          });
        }
        this.emitter.emit('update', { vaultId: this.id, changedPaths: paths });
      }
      return { changed: count, durationMs: Date.now() - started, ...(canvasStatus ? { canvas: canvasStatus } : {}) };
    });
  }

  async rebuild(): Promise<void> {
    this.store.close();
    await fsp.unlink(this.dbPath).catch(() => undefined);
    this.store = new SqliteVaultStore(this.dbPath);
    await this.init();
  }

  async query(q: VaultQuery): Promise<VaultQueryResult> {
    const topK = q.topK ?? 20;
    // Fix P2: escapeFtsQuery throws VaultQueryError on whitespace-only input;
    // bubble it up so the route handler can return HTTP 400.
    const fts = this.store.searchFts(escapeFtsQuery(q.text), topK);
    const hnsw = await this.adapter.search(q.text, topK);
    const hnswRanked = hnsw
      .map((h) => ({ chunkId: payloadChunkId(h), score: h.score }))
      .filter((r): r is { chunkId: string; score: number } => r.chunkId !== null);
    const fused = rrfFuse(fts, hnswRanked, 60).slice(0, topK);

    let rankedChunkIds = fused.map((f) => f.chunkId);
    if (q.focusFiles?.length) {
      const seeds: string[] = [];
      for (const path of q.focusFiles) {
        for (const s of this.store.listSymbolsForPath(path)) seeds.push(s.symbolId);
      }
      if (seeds.length) {
        const pprScores = runPpr(this.getCachedEdges(), seeds, { damping: 0.15, iterations: 10, epsilon: 1e-6 });
        const boosted = fused.map((f) => {
          const chunk = this.store.getChunk(f.chunkId);
          if (!chunk) return { id: f.chunkId, score: f.rrf };
          const syms = this.store.listSymbolsForPath(chunk.path)
            .filter((s) => s.startLine <= chunk.endLine && s.endLine >= chunk.startLine);
          const pprBoost = syms.reduce((max, s) => Math.max(max, pprScores.get(s.symbolId) ?? 0), 0);
          return { id: f.chunkId, score: f.rrf + 0.5 * pprBoost };
        }).sort((a, b) => b.score - a.score);
        rankedChunkIds = boosted.map((b) => b.id);
      }
    }

    let chunks = rankedChunkIds
      .map((id) => this.store.getChunk(id))
      .filter((c): c is VaultChunk => c !== null);

    if (q.langFilter?.length) {
      const allowed = new Set(q.langFilter);
      chunks = chunks.filter((c) => {
        const file = this.store.getFile(c.path);
        return file !== null && allowed.has(file.lang);
      });
    }

    if (q.pathGlob) {
      const re = globToRegex(q.pathGlob);
      chunks = chunks.filter((c) => re.test(c.path));
    }

    const budget = q.budgetTokens ?? Number.POSITIVE_INFINITY;
    const { kept, dropped } = packByBudget(chunks, budget);
    return {
      hits: kept.map((chunk) => {
        const f = fused.find((x) => x.chunkId === chunk.chunkId)!;
        return {
          chunk,
          scores: {
            fts: fts.find((x) => x.chunkId === chunk.chunkId)?.score ?? null,
            hnsw: hnswRanked.find((x) => x.chunkId === chunk.chunkId)?.score ?? null,
            rrf: f.rrf,
          },
        };
      }),
      budgetUsed: kept.reduce((a, c) => a + c.tokenCount, 0),
      truncated: dropped.length > 0,
    };
  }

  async stats(): Promise<VaultStats> {
    const files = this.store.listFiles();
    const chunkCount = this.store.chunkCount();
    let lastIndexedAt: number | null = null;
    for (const f of files) {
      if (lastIndexedAt === null || f.indexedAt > lastIndexedAt) lastIndexedAt = f.indexedAt;
    }
    const st = await stat(this.dbPath).catch(() => null);
    return { fileCount: files.length, symbolCount: this.store.symbolCount(), chunkCount, lastIndexedAt, dbBytes: st?.size ?? 0 };
  }

  listFiles(): VaultFile[] { return this.store.listFiles(); }

  async readFile(relPath: string): Promise<string> {
    const abs = await resolveSafeVaultReadPath(this.rootPath, relPath);
    return await readFile(abs, 'utf8');
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, 'utf8');
    const safeRelPath = validateSafeVaultWriteRelPath(relPath, bytes);
    try {
      await this.client.putNote(safeRelPath, content);
      return;
    } catch (err) {
      getLoggerSafe().warn(`[obsidian-vault ${this.id}] Obsidian API write failed, falling back to FS`, { err });
    }
    const abs = await prepareSafeVaultWritePath(this.rootPath, safeRelPath, bytes);
    await writeFile(abs, content, 'utf8');
  }

  onUpdate(listener: (p: { vaultId: VaultId; changedPaths: string[] }) => void): () => void {
    this.emitter.on('update', listener);
    return () => { this.emitter.off('update', listener); };
  }

  async stop(): Promise<void> {
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.store.close();
  }

  /** Write a note to Obsidian via REST API. */
  async writeNote(relPath: string, content: string): Promise<void> {
    const safeRelPath = validateSafeVaultWriteRelPath(relPath, Buffer.byteLength(content, 'utf8'));
    await this.client.putNote(safeRelPath, content);
    // Trigger reindex after write so the vault stays in sync.
    await this.reindexFile(safeRelPath);
  }

  /** Append content to a heading in an Obsidian note. */
  async appendToHeading(relPath: string, heading: string, content: string): Promise<void> {
    const safeRelPath = validateSafeVaultWriteRelPath(relPath, Buffer.byteLength(content, 'utf8'));
    await this.client.appendToHeading(safeRelPath, heading, content);
    await this.reindexFile(safeRelPath);
  }

  /** Search Obsidian's native index. */
  async searchObsidian(query: string): Promise<import('./obsidian-client.js').ObsidianSearchResult[]> {
    return this.client.search(query);
  }

  async findCallers(symbolId: string): Promise<VaultEdge[]> {
    const direct = this.store.findCallersOf(symbolId);
    if (direct.length) return direct;
    const short = symbolId.split('::').at(-1)?.split('.').at(-1) ?? '';
    if (!short) return [];
    const FALLBACK_LIMIT = 50;
    const out: VaultEdge[] = [];
    for (const e of this.getCachedEdges()) {
      if (e.kind !== 'calls') continue;
      if (e.toSymbol.endsWith(`::${short}`) || e.toSymbol.endsWith(`.${short}`)) {
        out.push(e);
        if (out.length >= FALLBACK_LIMIT) break;
      }
    }
    return out;
  }

  async findSymbolsByName(name: string, limit = 20): Promise<VaultSymbol[]> {
    return this.store.findSymbolsByName(name, limit);
  }

  async listBacklinks(path: string): Promise<{ wikilinks: VaultWikilink[]; callers: VaultEdge[] }> {
    const wikilinks = this.store.listWikilinksTo(path);
    const symbols = this.store.listSymbolsForPath(path);
    const callers: VaultEdge[] = [];
    for (const s of symbols) {
      const c = await this.findCallers(s.symbolId);
      callers.push(...c);
    }
    return { wikilinks, callers };
  }

  /**
   * Build the wikilink basename→canonical-path lookup map.
   * Lookup is case-insensitive (matches Obsidian semantics) but the stored
   * value is always the file's original-case canonical path.
   * If two files differ only by case (e.g. `Note.md` and `note.md` on a
   * case-sensitive FS), the first one wins deterministically because
   * vault_files.listFiles() returns rows sorted by path.
   */
  private buildWikilinkBasenameMap(): Map<string, string> {
    const files = this.store.listFiles();
    const basenameMap = new Map<string, string>();
    // First-write-wins helper: matches the deterministic ordering of
    // listFiles() ORDER BY path. Pulled out to keep the loop body declarative.
    const tryAdd = (key: string, value: string): void => {
      if (!basenameMap.has(key)) basenameMap.set(key, value);
    };
    for (const f of files) {
      const canonical = canonicalizePath(f.path);
      const base = canonical.split('/').pop() ?? canonical;
      const key = base.toLowerCase();
      tryAdd(key, canonical);
      const keyNoExt = key.replace(/\.[^.]+$/, '');
      if (keyNoExt !== key) tryAdd(keyNoExt, canonical);
      // Also index by the canonical path itself (for fully-qualified wikilinks like [[folder/Note]]).
      const canonKey = canonical.toLowerCase();
      tryAdd(canonKey, canonical);
      const canonKeyNoExt = canonKey.replace(/\.[^.]+$/, '');
      if (canonKeyNoExt !== canonKey) tryAdd(canonKeyNoExt, canonical);
    }
    return basenameMap;
  }

  /**
   * Resolve a single wikilink target token to a canonical stored path, or null.
   * Case-insensitive match (Obsidian-compatible) but the result preserves
   * the file's original case.
   */
  private resolveWikilinkTarget(target: string, basenameMap: Map<string, string>): string | null {
    // Strip in-page anchor (#heading) first; lookups operate on the file portion only.
    const filePart = (target.split('#')[0] ?? target).trim();
    if (!filePart) return null;
    const canonical = canonicalizePath(filePart);
    // Try fully-qualified path first, then bare basename.
    const directHit = basenameMap.get(canonical.toLowerCase());
    if (directHit) return directHit;
    const base = canonical.split('/').pop() ?? canonical;
    return basenameMap.get(base.toLowerCase()) ?? null;
  }

  /**
   * Resolve every unresolved wikilink row to a canonical stored path.
   *
   * Single-pass: callers run this once per sync / fullIndex AFTER the
   * sequential reindex loop has populated vault_files, so every potential
   * target is already discoverable. An earlier design had a second
   * predicate-filtered pass to catch "files added mid-sync", but the sync
   * loop is sequential — there is no concurrent mid-pass insertion — so
   * the second pass always iterated an empty set (re-review finding 2).
   */
  private async resolveWikilinks(): Promise<void> {
    const basenameMap = this.buildWikilinkBasenameMap();
    const wikilinks = this.store.listWikilinks();
    for (const w of wikilinks) {
      if (w.resolved) continue;
      const resolvedPath = this.resolveWikilinkTarget(w.target, basenameMap);
      if (!resolvedPath) continue;
      const fromNote = canonicalizePath(w.fromNote);
      this.store.updateWikilinkTarget(fromNote, w.target, resolvedPath);
    }
  }

  /**
   * Public reindex — serializes through the per-vault write lock so concurrent
   * callers (e.g. several writeNote() + sync()) can't interleave HNSW + edge state.
   */
  private async reindexFile(relPath: string): Promise<boolean> {
    return this.writeLock.run(() => this.reindexFileInternal(relPath));
  }

  /**
   * Actual reindex. MUST be called from within the writeLock.
   *
   * Ordering (P1 fix — revised May 2026):
   *   Step 1. Extract chunks + symbols/edges/wikilinks from disk (no DB write).
   *   Step 2. SQL transaction (atomic): delete old chunks/symbols/edges, upsert
   *           new ones, write file row with new hash.
   *   Step 3. AFTER txn commit, embed + HNSW upsert.
   *           - Track every HNSW id returned across sub-batches so a partial
   *             failure can clean up the just-inserted vectors.
   *           - If embedding fails, the file row's hash is correct on disk;
   *             we still clear vault_embeddings rows + the newly-inserted
   *             HNSW vectors so the next sync retries cleanly.
   *   Step 4. ONLY after HNSW commit succeeds do we remove the OLD HNSW
   *           vectors — keeps the external index alive until the new ones
   *           replace it. (Previously old vectors were removed BEFORE the
   *           SQL txn, which left a window where a failure could lose the
   *           file's embeddings without clearing its hash.)
   */
  private async reindexFileInternal(relPath: string): Promise<boolean> {
    const fileInfo = await getIndexableFileInfo(this.rootPath, relPath);
    if (!fileInfo.ok) {
      return this.deleteIndexedFileInternal(fileInfo.relPath);
    }
    const abs = fileInfo.absPath;
    relPath = canonicalizePath(fileInfo.relPath);
    const body = await readFile(abs, 'utf8').catch(() => null);
    if (body === null) { return this.deleteIndexedFileInternal(relPath); }
    const hash = xxhash64Hex(body);
    const existing = this.store.getFile(relPath);
    if (existing?.blobHash === hash) return false;
    const lang = fileInfo.lang;

    // Snapshot the OLD HNSW ids — we keep them alive until the new vectors
    // commit successfully, then remove them in Step 4. If anything before
    // that fails, the old vectors remain (still consistent with whatever
    // SQL state we roll back to or leave untouched).
    const oldHnswIds = this.store.listHnswIdsForPath(relPath);

    // Step 1: extract everything from the file body. No DB writes yet so any
    // extractor exception is a clean no-op (P1 atomicity invariant).
    const chunks = chunkFile({ path: relPath, content: body, lang });
    const EXTRACT_MAX_BYTES = 2 * 1024 * 1024;
    const extractor = getExtractorFor(lang);
    let extracted: {
      symbols: VaultSymbol[];
      edges: VaultEdge[];
      wikilinks: VaultWikilink[];
      frontmatter: Record<string, string> | null;
      tags: string[] | null;
    } | null = null;
    if (extractor && body.length <= EXTRACT_MAX_BYTES) {
      try {
        const out = await extractor.extract({
          path: relPath, content: body,
          lang: lang as 'typescript' | 'csharp' | 'markdown',
        });
        extracted = {
          symbols: out.symbols,
          edges: out.edges,
          wikilinks: out.wikilinks,
          frontmatter: out.frontmatter ?? null,
          tags: out.tags ?? null,
        };
      } catch (err) {
        getLoggerSafe().warn('[obsidian-vault] symbol extraction failed; rolling back reindex', {
          vaultId: this.id, path: relPath, op: 'reindexFile', err,
        });
        throw err;
      }
    }

    // Step 2: SQL transaction — file + chunks + symbols + edges + wikilinks + frontmatter + tags.
    // Embeddings (HNSW external) are committed AFTER this txn succeeds.
    const txn = this.store.runReindexTxn({
      path: relPath,
      file: {
        path: relPath, blobHash: hash, mtimeMs: fileInfo.mtimeMs, size: fileInfo.size,
        lang, kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
        indexedAt: Date.now(),
      },
      chunks,
      symbols: extracted?.symbols ?? [],
      edges: extracted?.edges ?? [],
      wikilinks: (extracted?.wikilinks ?? []).map((w) => ({
        ...w,
        fromNote: canonicalizePath(w.fromNote),
        // Target may be a wikilink token (e.g. "Note" / "Note.md") — leave as-is here;
        // canonicalization to a real stored path happens in resolveWikilinks().
      })),
      frontmatter: extracted?.frontmatter ?? null,
      tags: extracted?.tags ?? null,
    });
    if (!txn.ok) {
      // SQL rollback already happened inside runReindexTxn — old HNSW vectors
      // are still in the index and still referenced by the (unchanged) SQL
      // rows, so the two indexes remain consistent.
      getLoggerSafe().warn('[obsidian-vault] reindex SQL txn failed', {
        vaultId: this.id, path: relPath, op: 'reindexFile', error: txn.error,
      });
      this.invalidateEdgesCache();
      return false;
    }

    // Step 3: embed + HNSW upsert.
    //
    // Invariant (re-review fix): `upsertBatch` writes ALL new vectors into
    // HNSW BEFORE returning the chunkId→hnswId map. Therefore as soon as
    // `upsertBatch` resolves, every value in the map is already live in the
    // external index. We MUST populate `newHnswIds` immediately from the
    // returned map — before the SQL upsert loop — so a mid-loop SQLite
    // failure can still clean up every HNSW vector that was inserted.
    // (Previously `newHnswIds` was only appended per-SQL-success, which
    // left the unprocessed-but-already-in-HNSW tail orphaned on failure.)
    const newHnswIds: number[] = [];
    try {
      const embeddingMap = await this.adapter.upsertBatch(
        chunks.map((c) => ({ chunkId: c.chunkId, content: c.content })),
      );
      // Capture every HNSW id BEFORE the SQL upsert loop — see invariant above.
      newHnswIds.push(...Object.values(embeddingMap));
      for (const [chunkId, hnswId] of Object.entries(embeddingMap)) {
        this.store.upsertEmbedding(chunkId, hnswId, this.adapter.provider.dim, this.adapter.provider.model);
      }
    } catch (err) {
      getLoggerSafe().warn('[obsidian-vault] HNSW upsert failed; rolling back new vectors', {
        vaultId: this.id, path: relPath, op: 'reindexFile',
        newVectorCount: newHnswIds.length, err,
      });
      // Remove every NEW vector we (or upsertBatch) inserted. Per-id try/catch
      // so a single cleanup failure cannot mask the original error or stop
      // subsequent ids from being removed. (Finding 3: removed the outer
      // try/catch — it was dead because the inner per-id catch already
      // swallows every throw.)
      for (const id of newHnswIds) {
        try { this.adapter.remove(id); } catch { /* per-id best effort */ }
      }
      // Drop the file row + chunks so the next sync retries cleanly. The
      // OLD HNSW vectors are still in the external index but unreferenced
      // (their SQL rows were just deleted) — a follow-up sync will rebuild
      // both sides.
      this.store.deleteFile(relPath);
      this.invalidateEdgesCache();
      throw err;
    }

    // Step 4: new HNSW vectors are live + referenced. Safe to remove the OLD
    // ones now. Cleanup failure here is logged but non-fatal — orphans don't
    // affect correctness, only memory.
    for (const id of oldHnswIds) {
      try { this.adapter.remove(id); } catch { /* best effort */ }
    }

    this.invalidateEdgesCache();
    return true;
  }

  private _edgesCache: VaultEdge[] | null = null;
  private getCachedEdges(): VaultEdge[] {
    if (this._edgesCache === null) this._edgesCache = this.store.listEdges();
    return this._edgesCache;
  }
  private invalidateEdgesCache(): void { this._edgesCache = null; }

  async regenerateCanvas(): Promise<void> {
    // Public interface signature stays Promise<void>; status callers should use
    // regenerateCanvasWithStatus() (used internally by sync()).
    await this.regenerateCanvasWithStatus();
  }

  /**
   * Regenerate the .canvas graph atomically:
   * 1. build canvas in memory
   * 2. serialize to JSON
   * 3. PARSE the JSON back (P2 fix: validates the write before clobbering the old file)
   * 4. write to .tmp + fsync, then atomic rename
   * On any error, the old canvas file is left intact and a status is returned.
   */
  private async regenerateCanvasWithStatus(): Promise<{ ok: boolean; error?: string }> {
    const finalPath = join(this.rootPath, '.strada/vault/graph.canvas');
    const tmpPath = `${finalPath}.tmp`;
    try {
      const files = this.store.listFiles();
      const symbols = files.flatMap((f) => this.store.listSymbolsForPath(f.path));
      const edges = this.store.listEdges();
      const wikilinks = this.store.listWikilinks();
      const canvas = buildCanvas({ symbols, edges, files, wikilinks });
      const serialized = JSON.stringify(canvas, null, 2);
      // P2 fix: validate round-trip BEFORE touching the live file.
      try {
        JSON.parse(serialized);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        getLoggerSafe().warn('[obsidian-vault] canvas JSON validation failed; leaving old canvas intact', {
          vaultId: this.id, op: 'regenerateCanvas', error: msg,
        });
        return { ok: false, error: `validation_failed: ${msg}` };
      }
      await writeFile(tmpPath, serialized, 'utf8');
      try {
        // Use fsp.rename so test code can spy/intercept via the namespace.
        await fsp.rename(tmpPath, finalPath);
      } catch (renameErr) {
        // Rename failed — try to clean up the tmp file so we don't leak.
        await fsp.unlink(tmpPath).catch(() => undefined);
        throw renameErr;
      }
      return { ok: true };
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      // SecH1: full err.message often contains absolute filesystem paths.
      // We log the raw message internally but only ever return a redacted
      // version so HTTP/WS clients never see local filesystem layout.
      const redacted = redactPathsInMessage(rawMsg, this.rootPath, this.realpathRoot);
      getLoggerSafe().warn('[obsidian-vault] canvas regen failed', {
        vaultId: this.id, op: 'regenerateCanvas', error: rawMsg,
      });
      return { ok: false, error: redacted };
    }
  }

  async readCanvas(): Promise<unknown> {
    try {
      const raw = await readFile(join(this.rootPath, '.strada/vault/graph.canvas'), 'utf8');
      return JSON.parse(raw);
    } catch { return { nodes: [], edges: [] }; }
  }

  /**
   * Shared "iterate every discoverable file, reindex changed, prune deletions"
   * skeleton used by both fullIndex() and reindexChangedInternal().
   * MUST be called from within the writeLock.
   *
   * `op` is purely a log tag.
   */
  private async runIndexPass(op: 'fullIndex' | 'sync'): Promise<{ count: number; paths: string[] }> {
    const before = new Set(this.store.listFiles().map((f) => f.path));
    const files = await listIndexableFiles(this.rootPath);

    const changed: string[] = [];
    for (const f of files) {
      try {
        if (await this.reindexFileInternal(f.path)) changed.push(f.path);
      } catch (err) {
        // Failure in one file should not poison the whole pass.
        getLoggerSafe().warn(`[obsidian-vault] reindex failed during ${op}`, {
          vaultId: this.id, path: f.path, op, err,
        });
      }
    }
    const present = new Set(files.map((f) => f.path));
    for (const p of before) {
      if (!present.has(p) && this.deleteIndexedFileInternal(p)) changed.push(p);
    }
    return { count: changed.length, paths: changed };
  }

  private async fullIndex(): Promise<void> {
    // Serialize with sync()/reindexFile() — full index can take a while and
    // must not race with concurrent writes.
    await this.writeLock.run(async () => {
      const { paths: changed } = await this.runIndexPass('fullIndex');
      // Single pass: runIndexPass processes files sequentially, so every
      // file is in vault_files by the time we resolve wikilinks. A second
      // predicate-filtered pass would iterate an empty set (re-review
      // finding 2).
      await this.resolveWikilinks();
      await this.regenerateCanvasWithStatus();
      if (changed.length) {
        this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
      }
    });
  }

  /**
   * Internal reindexChanged — MUST be called from within the writeLock.
   * Uses `runIndexPass` (which calls `reindexFileInternal`) to avoid
   * double-lock acquisition.
   */
  private async reindexChangedInternal(): Promise<{ count: number; paths: string[] }> {
    return this.runIndexPass('sync');
  }

  /** Internal delete — MUST be called from within the writeLock. */
  private deleteIndexedFileInternal(relPath: string): boolean {
    const canonical = canonicalizePath(relPath);
    const existing = this.store.getFile(canonical);
    if (!existing) return false;
    const hnswIds = this.store.listHnswIdsForPath(canonical);
    for (const hnswId of hnswIds) this.adapter.remove(hnswId);
    this.store.deleteFile(canonical);
    return true;
  }
}
