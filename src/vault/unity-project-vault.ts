import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SqliteVaultStore } from './sqlite-vault-store.js';
import { chunkFile } from './chunker.js';
import { xxhash64Hex } from './hash.js';
import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from './embedding-adapter.js';
import { rrfFuse, packByBudget } from './query-pipeline.js';
import { listIndexableFiles } from './discovery.js';
import {
  getIndexableFileInfo,
  prepareSafeVaultWritePath,
  resolveSafeVaultReadPath,
} from './path-policy.js';
import { getExtractorFor, type ExtractOutput } from './symbol-extractor/index.js';
import { buildCanvas } from './canvas-generator.js';
import { runPpr } from './ppr.js';
import { getLoggerSafe } from '../utils/logger.js';
import { AsyncLock } from './async-lock.js';
import { escapeFtsQuery } from './fts-query.js';
import type {
  IVault, VaultFile, VaultQuery, VaultQueryResult, VaultStats, VaultId, VaultChunk,
  VaultSymbol, VaultEdge, VaultWikilink,
} from './vault.interface.js';

/**
 * How many extra candidates to retrieve per requested result when a
 * langFilter/pathGlob is active. Filtering happens after retrieval, so the
 * candidate pool must be wider than topK or a selective filter starves the
 * result set. 5x covers a filter that matches ~20% of the corpus.
 */
const FILTER_OVERFETCH = 5;

/** Hard ceiling on the over-fetch, so a large topK cannot turn one query into
 *  an unbounded scan. */
const MAX_FETCH_K = 200;

export interface UnityVaultDeps {
  id: VaultId;
  rootPath: string;
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
}

// Minimal interface for the watcher — avoids hard import of not-yet-existing watcher.ts.
interface IVaultWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
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

export class UnityProjectVault implements IVault {
  readonly id: VaultId;
  readonly kind: 'unity-project' | 'self' | 'knowledge' = 'unity-project';
  readonly rootPath: string;
  protected store: SqliteVaultStore;
  protected adapter: EmbeddingAdapter;
  protected emitter = new EventEmitter();
  protected dbPath: string;
  protected watcher: IVaultWatcher | null = null;
  private initialized = false;
  /** Serializes reindexFile()/delete passes — mirrors ObsidianVault.writeLock. */
  protected writeLock = new AsyncLock();
  /**
   * Throttles the per-file "embedding failed" WARN. When the embedding backend
   * is down, indexing throws once per file (~1 line per indexed file, e.g. 1500+
   * identical warnings). We warn at most once per window and demote the rest to
   * DEBUG so a single dead service can't drown the log. (The bootstrap embedding
   * health-gate prevents the common dead-Ollama case; this is the safety net for
   * transient/partial failures.)
   */
  private lastEmbedWarnAtMs = 0;
  private static readonly EMBED_WARN_WINDOW_MS = 60_000;

  constructor(deps: UnityVaultDeps) {
    this.id = deps.id;
    this.rootPath = deps.rootPath;
    this.dbPath = join(deps.rootPath, '.strada/vault/index.db');
    // Create the DB directory synchronously so better-sqlite3 can open the file.
    mkdirSync(join(deps.rootPath, '.strada/vault'), { recursive: true });
    this.store = new SqliteVaultStore(this.dbPath);
    this.adapter = new EmbeddingAdapter(deps.embedding, deps.vectorStore);
  }

  async init(): Promise<void> {
    // Idempotent ONLY while a watcher is live: the watcher owns freshness then,
    // so re-invoking vault_init on a running vault used to re-walk the entire
    // tree per call — a full disk pass each time on days-long autonomous runs.
    // Without a watcher nothing maintains freshness, so init() must still
    // reconcile the index against the disk (files may have been deleted or
    // added while the vault was offline).
    if (this.initialized && this.watcher) return;
    await mkdir(join(this.rootPath, '.strada/vault/codebase'), { recursive: true });
    this.store.migrate();
    await this.fullIndex();
    this.initialized = true;
  }

  async sync(): Promise<{ changed: number; durationMs: number }> {
    const started = Date.now();
    const changed = await this.reindexChanged();
    return { changed, durationMs: Date.now() - started };
  }

  async rebuild(): Promise<void> {
    this.store.close();
    await unlink(this.dbPath).catch(() => undefined);
    this.store = new SqliteVaultStore(this.dbPath);
    // Clear stale HNSW state so old hnsw_id pointers don't leak into the new index
    this.adapter.store.clear();
    // A rebuild deliberately discards the index — init()'s idempotence guard
    // must not read as "already done" or the fresh store stays empty.
    this.initialized = false;
    await this.init();
  }

  async query(q: VaultQuery): Promise<VaultQueryResult> {
    const topK = q.topK ?? 20;
    // langFilter / pathGlob are CANDIDATE constraints, not a post-trim. They
    // used to run after the fused list had already been cut to topK, so a
    // filtered search returned roughly nothing: ask for the top 20 with
    // langFilter ["csharp"] and if those 20 happened to be markdown, every one
    // was discarded and the query came back empty. Over-fetch while a filter
    // is active so there is still a full result set left after filtering, and
    // apply the topK cut at the end.
    const filtersActive = Boolean(q.langFilter?.length || q.pathGlob);
    const fetchK = filtersActive ? Math.min(topK * FILTER_OVERFETCH, MAX_FETCH_K) : topK;
    const fts = this.store.searchFts(escapeFtsQuery(q.text), fetchK);
    // Embeddings only ENHANCE retrieval. Skip the embed + vector-search
    // round-trip entirely when the backing store is non-semantic (no real
    // HNSW backend) so a placeholder/unwired store can't fuse noise vectors
    // into the lexical (BM25) ranking. When semantic, fuse via RRF as before.
    const hnswRanked: Array<{ chunkId: string; score: number }> = this.adapter.isSemantic()
      ? (await this.adapter.search(q.text, fetchK))
          .map((h) => ({ chunkId: payloadChunkId(h), score: h.score }))
          .filter((r): r is { chunkId: string; score: number } => r.chunkId !== null)
      : [];
    // NOT sliced here — the cut to topK happens after filtering (see below).
    const fused = rrfFuse(fts, hnswRanked, 60);

    // Phase 2: optional Personalized PageRank re-rank when focusFiles is provided.
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

    // Fix I1: apply langFilter
    if (q.langFilter?.length) {
      const allowed = new Set(q.langFilter);
      chunks = chunks.filter((c) => {
        const file = this.store.getFile(c.path);
        return file !== null && allowed.has(file.lang);
      });
    }

    // Fix I1: apply pathGlob
    if (q.pathGlob) {
      const re = globToRegex(q.pathGlob);
      chunks = chunks.filter((c) => re.test(c.path));
    }

    // Cut to topK only now that filtering has run, so the caller gets topK
    // matching chunks rather than "whatever survives filtering out of topK".
    chunks = chunks.slice(0, topK);

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
      truncated: dropped.length > 0,  // Fix I2: use dropped from packByBudget
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
    const abs = await prepareSafeVaultWritePath(this.rootPath, relPath, Buffer.byteLength(content, 'utf8'));
    await writeFile(abs, content, 'utf8');
  }

  onUpdate(listener: (p: { vaultId: VaultId; changedPaths: string[] }) => void): () => void {
    this.emitter.on('update', listener);
    return () => { this.emitter.off('update', listener); };
  }

  async startWatch(debounceMs = 800): Promise<void> {
    if (this.watcher) return;
    // Dynamic import — watcher.ts is a future Task 9 file; will throw if not yet present.
    let WatcherCtor: new (opts: {
      root: string; debounceMs: number; onBatch: (paths: string[]) => Promise<void>;
    }) => IVaultWatcher;
    try {
      const mod = await import('./watcher.js') as { VaultWatcher: typeof WatcherCtor };
      WatcherCtor = mod.VaultWatcher;
    } catch {
      throw new Error('VaultWatcher not available — watcher.ts is not yet implemented (Task 9)');
    }
    // Re-check after the await: two concurrent startWatch() calls both pass the
    // guard above inside the import window, and the first watcher instance is
    // then overwritten — orphaned with live fds, unreachable by stopWatch()
    // forever. SelfVault defends this exact race with the same double-check.
    if (this.watcher) return;
    this.watcher = new WatcherCtor({
      root: this.rootPath,
      debounceMs,
      onBatch: async (paths) => {
        // Fix I3: wrap each reindex call so one failing file doesn't abort the batch.
        const changed: string[] = [];
        for (const p of paths) {
          try {
            if (await this.reindexFile(p)) changed.push(p);
          } catch (err) {
            getLoggerSafe().warn(`[vault ${this.id}] reindexFile failed for ${p}`, { err });
          }
        }
        if (changed.length) {
          await this.regenerateCanvas();
          this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
        }
      },
    });
    await this.watcher.start();
  }

  async stopWatch(): Promise<void> {
    if (this.watcher) { await this.watcher.stop(); this.watcher = null; }
  }

  async stop(): Promise<void> {
    await this.dispose();
  }

  async dispose(): Promise<void> {
    await this.stopWatch();
    this.store.close();
  }

  async reindexFile(relPath: string): Promise<boolean> {
    return this.writeLock.run(() => this.reindexFileInternal(relPath));
  }

  /**
   * Actual reindex. MUST be called from within the writeLock.
   *
   * Ordering: snapshot the OLD HNSW ids but keep them live; write the SQL rows
   * + chunks; embed the NEW vectors; ONLY on embed success remove the OLD
   * vectors. On embed failure, roll back any partial new vectors and reset the
   * stored hash so the next sync re-embeds — this prevents a transient
   * embedding failure from permanently losing a file's vectors.
   */
  protected async reindexFileInternal(relPath: string): Promise<boolean> {
    const fileInfo = await getIndexableFileInfo(this.rootPath, relPath);
    if (!fileInfo.ok) {
      return this.deleteIndexedFileInternal(fileInfo.relPath);
    }
    const abs = fileInfo.absPath;
    relPath = fileInfo.relPath;
    const body = await readFile(abs, 'utf8').catch(() => null);
    if (body === null) { return this.deleteIndexedFileInternal(relPath); }
    const hash = xxhash64Hex(body);
    const existing = this.store.getFile(relPath);
    if (existing?.blobHash === hash) return false;  // Fix C1: short-circuit on unchanged hash
    const lang = fileInfo.lang;

    // Snapshot the OLD HNSW ids — keep them alive until the NEW vectors commit
    // successfully (removed in the embedOk branch below). Removing them up front
    // would lose the file's vectors if embedding then fails transiently.
    const oldHnswIds = this.store.listHnswIdsForPath(relPath);

    // Phase-2 extraction BEFORE the SQL transaction (the extractor is async,
    // SQLite is sync). Best-effort — an extractor failure must not block indexing.
    // phase2-review M2: cap content size to prevent extractor DoS via huge files.
    const EXTRACT_MAX_BYTES = 2 * 1024 * 1024;
    const extractor = getExtractorFor(lang);
    let extracted: ExtractOutput | null = null;
    if (extractor && body.length <= EXTRACT_MAX_BYTES) {
      try {
        extracted = await extractor.extract({
          path: relPath, content: body,
          lang: lang as 'typescript' | 'csharp' | 'markdown',
        });
      } catch (err) {
        getLoggerSafe().warn(`[vault ${this.id}] symbol extraction failed for ${relPath}`, { err });
      }
    } else if (extractor) {
      getLoggerSafe().debug(`[vault ${this.id}] skipping symbol extraction for ${relPath} (${body.length} bytes > cap)`);
    }

    // ATOMIC SQL reindex (crash-safety fix, measured 2026-08-23): the old sequence
    // ran deleteFile → upsertFile(new hash) → per-chunk upserts as SEPARATE
    // transactions, so a crash mid-loop left the file row marked current with
    // missing chunks — and the hash short-circuit then skipped re-indexing it
    // FOREVER. One transaction covers delete + file + chunks + symbols/edges/
    // wikilinks/frontmatter/tags. The file row is written with a PROVISIONAL empty
    // hash and only commits the real hash AFTER vectors are durable, so a crash at
    // ANY point before that forces a clean redo next sync instead of silently
    // skipping a half-indexed file.
    const fileFields = {
      path: relPath, blobHash: '', mtimeMs: fileInfo.mtimeMs, size: fileInfo.size,
      lang, kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
      indexedAt: Date.now(),
    } as const;
    const chunks = chunkFile({ path: relPath, content: body, lang });
    const txn = this.store.runReindexTxn({
      path: relPath,
      file: fileFields,
      chunks,
      symbols: extracted?.symbols ?? [],
      edges: extracted?.edges ?? [],
      wikilinks: extracted?.wikilinks ?? [],
      frontmatter: extracted?.frontmatter ?? null,
      tags: extracted?.tags ?? null,
    });
    if (!txn.ok) {
      getLoggerSafe().warn(`[vault ${this.id}] reindex SQL txn failed for ${relPath}`, { error: txn.error });
      this.invalidateEdgesCache();
      return false;
    }

    // Embed the NEW vectors first; only remove the OLD ones after success.
    // Embedding is best-effort — on failure we roll back any partial new vectors
    // and LEAVE the provisional empty hash so the next sync redoes the whole file
    // instead of short-circuiting on an up-to-date-but-vector-less row.
    const newHnswIds: number[] = [];
    let embedOk = false;
    try {
      const embeddingMap = await this.adapter.upsertBatch(chunks.map((c) => ({ chunkId: c.chunkId, content: c.content })));
      newHnswIds.push(...Object.values(embeddingMap));
      // Persist chunk_id → hnsw_id mapping for future vector lifecycle management.
      for (const [chunkId, hnswId] of Object.entries(embeddingMap)) {
        this.store.upsertEmbedding(chunkId, hnswId, this.adapter.provider.dim, this.adapter.provider.model);
      }
      embedOk = true;
    } catch (embedErr) {
      const embedErrMsg = embedErr instanceof Error ? embedErr.message : String(embedErr);
      const nowMs = Date.now();
      // Warn at most once per window; demote the rest to DEBUG so a dead backend
      // can't flood the log with one identical line per file.
      if (nowMs - this.lastEmbedWarnAtMs > UnityProjectVault.EMBED_WARN_WINDOW_MS) {
        this.lastEmbedWarnAtMs = nowMs;
        getLoggerSafe().warn(`[vault ${this.id}] embedding failed for ${relPath} (and possibly other files), keeping prior vectors; will retry next sync — fix the embedding backend to enable semantic search`, {
          error: embedErrMsg,
        });
      } else {
        getLoggerSafe().debug(`[vault ${this.id}] embedding failed for ${relPath}, keeping prior vectors; will retry next sync`, {
          error: embedErrMsg,
        });
      }
      // Roll back any vectors inserted before the failure. The provisional empty
      // hash is already committed — nothing further to reset.
      for (const id of newHnswIds) {
        try { this.adapter.remove(id); } catch { /* per-id best effort */ }
      }
    }
    if (embedOk) {
      for (const id of oldHnswIds) {
        try { this.adapter.remove(id); } catch { /* best effort */ }
      }
      // Commit the real hash ONLY now: SQL rows AND vectors are both durable, so
      // the unchanged-hash short-circuit can never skip an incomplete reindex.
      this.store.upsertFile({ ...fileFields, blobHash: hash, indexedAt: Date.now() });
    }

    this.invalidateEdgesCache();
    return true;
  }

  async findCallers(symbolId: string): Promise<VaultEdge[]> {
    const direct = this.store.findCallersOf(symbolId);
    if (direct.length) return direct;
    // Name-tail fallback for unresolved externs. Cap matches to avoid accidental fan-out
    // when the short name is common (phase2-review I6).
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

  // Phase2-review I3: cache listEdges for query/PPR/findCallers hot paths, invalidated
  // whenever reindexFile changes anything. For 50k-edge projects, the full scan per query
  // was a measurable hit; caching is safe because edge mutations all flow through reindexFile.
  private _edgesCache: VaultEdge[] | null = null;
  private getCachedEdges(): VaultEdge[] {
    if (this._edgesCache === null) this._edgesCache = this.store.listEdges();
    return this._edgesCache;
  }
  private invalidateEdgesCache(): void { this._edgesCache = null; }

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

  /** Test hook — avoids exposing the store directly to consumers. */
  listSymbolsForTest(path: string): VaultSymbol[] {
    return this.store.listSymbolsForPath(path);
  }

  async regenerateCanvas(): Promise<void> {
    try {
      const files = this.store.listFiles();
      const symbols = files.flatMap((f) => this.store.listSymbolsForPath(f.path));
      const edges = this.store.listEdges();
      const wikilinks = this.store.listWikilinks();
      const canvas = buildCanvas({ symbols, edges, files, wikilinks });
      // phase2-review L1: atomic write via temp + rename so readCanvas/GET /canvas
      // never observes a partial JSON document mid-write.
      const finalPath = join(this.rootPath, '.strada/vault/graph.canvas');
      const tmpPath = `${finalPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(canvas, null, 2), 'utf8');
      const { rename } = await import('node:fs/promises');
      await rename(tmpPath, finalPath);
    } catch (err) {
      getLoggerSafe().warn(`[vault ${this.id}] canvas regen failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async readCanvas(): Promise<unknown> {
    try {
      const raw = await readFile(join(this.rootPath, '.strada/vault/graph.canvas'), 'utf8');
      return JSON.parse(raw);
    } catch { return { nodes: [], edges: [] }; }
  }

  protected async fullIndex(): Promise<void> {
    const before = new Set(this.store.listFiles().map((f) => f.path));
    const files = await listIndexableFiles(this.rootPath);
    const changed: string[] = [];
    for (const f of files) {
      try {
        if (await this.reindexFile(f.path)) changed.push(f.path);
      } catch (err) {
        getLoggerSafe().warn(`[vault ${this.id}] skipping ${f.path} during fullIndex`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const present = new Set(files.map((f) => f.path));
    for (const p of before) {
      if (!present.has(p) && await this.writeLock.run(async () => this.deleteIndexedFileInternal(p))) changed.push(p);
    }
    await this.regenerateCanvas();
    if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
  }

  private async reindexChanged(): Promise<number> {
    // Fix CodeRevC1: capture the pre-scan state of the DB BEFORE we reindex,
    // so deletion detection compares apples to apples even if reindexFile mutates store mid-loop.
    const before = new Set(this.store.listFiles().map((f) => f.path));
    const files = await listIndexableFiles(this.rootPath);
    const changed: string[] = [];
    for (const f of files) {
      try {
        if (await this.reindexFile(f.path)) changed.push(f.path);
      } catch (err) {
        getLoggerSafe().warn(`[vault ${this.id}] skipping ${f.path} during reindexChanged`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const present = new Set(files.map((f) => f.path));
    for (const p of before) {
      if (!present.has(p)) {
        if (await this.writeLock.run(async () => this.deleteIndexedFileInternal(p))) changed.push(p);
      }
    }
    await this.regenerateCanvas();
    if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
    return changed.length;
  }

  protected deleteIndexedFileInternal(relPath: string): boolean {
    const existing = this.store.getFile(relPath);
    if (!existing) return false;
    // Fix HNSW leak: remove vectors for deleted files before deleting SQLite rows.
    const hnswIds = this.store.listHnswIdsForPath(relPath);
    for (const hnswId of hnswIds) this.adapter.remove(hnswId);
    this.store.deleteFile(relPath);
    return true;
  }
}
