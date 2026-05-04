import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { EventEmitter } from 'node:events';
import { SqliteVaultStore } from './sqlite-vault-store.js';
import { chunkFile } from './chunker.js';
import { xxhash64Hex } from './hash.js';
import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from './embedding-adapter.js';
import { rrfFuse, packByBudget } from './query-pipeline.js';
import { EXT_LANG } from './discovery.js';
import { getExtractorFor } from './symbol-extractor/index.js';
import { buildCanvas } from './canvas-generator.js';
import { runPpr } from './ppr.js';
import { getLoggerSafe } from '../utils/logger.js';
import { ObsidianApiClient, type ObsidianApiConfig } from './obsidian-client.js';
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

function inferLang(path: string): VaultFile['lang'] {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return EXT_LANG[ext] ?? 'unknown';
}

function escapeFtsQuery(q: string): string {
  const stripped = q.replace(/["*:()^+\-]/g, ' ').replace(/\b(NOT|AND|OR|NEAR)\b/g, ' ').trim();
  if (!stripped) return '""';
  return `"${stripped}"`;
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
  private store: SqliteVaultStore;
  private adapter: EmbeddingAdapter;
  private emitter = new EventEmitter();
  private dbPath: string;
  private client: ObsidianApiClient;

  constructor(deps: ObsidianVaultDeps) {
    this.id = deps.id;
    this.rootPath = deps.rootPath;
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

  async sync(): Promise<{ changed: number; durationMs: number }> {
    const started = Date.now();
    const changed = await this.reindexChanged();
    if (changed > 0) {
      await this.resolveWikilinks();
      await this.regenerateCanvas();
      this.emitter.emit('update', { vaultId: this.id, changedPaths: [] });
    }
    return { changed, durationMs: Date.now() - started };
  }

  async rebuild(): Promise<void> {
    this.store.close();
    const { unlink } = await import('node:fs/promises');
    await unlink(this.dbPath).catch(() => undefined);
    this.store = new SqliteVaultStore(this.dbPath);
    await this.init();
  }

  async query(q: VaultQuery): Promise<VaultQueryResult> {
    const topK = q.topK ?? 20;
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
    return { fileCount: files.length, chunkCount, lastIndexedAt, dbBytes: st?.size ?? 0 };
  }

  listFiles(): VaultFile[] { return this.store.listFiles(); }

  async readFile(relPath: string): Promise<string> {
    const abs = join(this.rootPath, relPath);
    const rel = relative(this.rootPath, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`path escapes vault root: ${relPath}`);
    }
    return await readFile(abs, 'utf8');
  }

  onUpdate(listener: (p: { vaultId: VaultId; changedPaths: string[] }) => void): () => void {
    this.emitter.on('update', listener);
    return () => { this.emitter.off('update', listener); };
  }

  async dispose(): Promise<void> {
    this.store.close();
  }

  /** Write a note to Obsidian via REST API. */
  async writeNote(relPath: string, content: string): Promise<void> {
    await this.client.putNote(relPath, content);
    // Trigger reindex after write so the vault stays in sync.
    await this.reindexFile(relPath);
  }

  /** Append content to a heading in an Obsidian note. */
  async appendToHeading(relPath: string, heading: string, content: string): Promise<void> {
    await this.client.appendToHeading(relPath, heading, content);
    await this.reindexFile(relPath);
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

  private async resolveWikilinks(): Promise<void> {
    const files = this.store.listFiles();
    const basenameMap = new Map<string, string>();
    for (const f of files) {
      const base = f.path.split('/').pop() ?? f.path;
      const key = base.toLowerCase();
      basenameMap.set(key, f.path);
      const keyNoExt = key.replace(/\.[^.]+$/, '');
      if (keyNoExt !== key) {
        basenameMap.set(keyNoExt, f.path);
      }
    }

    const wikilinks = this.store.listWikilinks();
    for (const w of wikilinks) {
      if (w.resolved) continue;
      const targetBase = w.target.split('/').pop() ?? w.target;
      const filePart = targetBase.split('#')[0] ?? targetBase;
      const resolvedPath = basenameMap.get(filePart.toLowerCase());
      if (resolvedPath) {
        this.store.updateWikilinkTarget(w.fromNote, w.target, resolvedPath);
      }
    }
  }

  private async reindexFile(relPath: string): Promise<boolean> {
    const abs = join(this.rootPath, relPath);
    const body = await readFile(abs, 'utf8').catch(() => null);
    if (body === null) { this.store.deleteFile(relPath); return true; }
    const hash = xxhash64Hex(body);
    const existing = this.store.getFile(relPath);
    if (existing?.blobHash === hash) return false;
    const st = await stat(abs);
    const lang = inferLang(relPath);

    const oldHnswIds = this.store.listHnswIdsForPath(relPath);
    for (const hnswId of oldHnswIds) this.adapter.remove(hnswId);

    this.store.deleteFile(relPath);
    this.store.upsertFile({
      path: relPath, blobHash: hash, mtimeMs: st.mtimeMs, size: st.size,
      lang, kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
      indexedAt: Date.now(),
    });
    const chunks = chunkFile({ path: relPath, content: body, lang });
    for (const c of chunks) this.store.upsertChunk(c);
    const embeddingMap = await this.adapter.upsertBatch(chunks.map((c) => ({ chunkId: c.chunkId, content: c.content })));
    for (const [chunkId, hnswId] of Object.entries(embeddingMap)) {
      this.store.upsertEmbedding(chunkId, hnswId, this.adapter.provider.dim, this.adapter.provider.model);
    }

    const EXTRACT_MAX_BYTES = 2 * 1024 * 1024;
    const extractor = getExtractorFor(lang);
    if (extractor && body.length <= EXTRACT_MAX_BYTES) {
      try {
        const out = await extractor.extract({
          path: relPath, content: body,
          lang: lang as 'typescript' | 'csharp' | 'markdown',
        });
        for (const s of out.symbols) this.store.upsertSymbol(s);
        for (const e of out.edges) this.store.upsertEdge(e);
        for (const w of out.wikilinks) this.store.upsertWikilink(w);
        if (out.frontmatter) {
          this.store.deleteFrontmatterByPath(relPath);
          for (const [key, value] of Object.entries(out.frontmatter)) {
            this.store.upsertFrontmatter(relPath, key, value);
          }
        }
        if (out.tags) {
          this.store.deleteTagsByPath(relPath);
          for (const tag of out.tags) {
            this.store.upsertTag(relPath, tag);
          }
        }
      } catch (err) {
        getLoggerSafe().warn(`[obsidian-vault ${this.id}] symbol extraction failed for ${relPath}`, { err });
      }
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
    try {
      const files = this.store.listFiles();
      const symbols = files.flatMap((f) => this.store.listSymbolsForPath(f.path));
      const edges = this.store.listEdges();
      const wikilinks = this.store.listWikilinks();
      const canvas = buildCanvas({ symbols, edges, files, wikilinks });
      const finalPath = join(this.rootPath, '.strada/vault/graph.canvas');
      const tmpPath = `${finalPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(canvas, null, 2), 'utf8');
      const { rename } = await import('node:fs/promises');
      await rename(tmpPath, finalPath);
    } catch (err) {
      getLoggerSafe().warn(`[obsidian-vault ${this.id}] canvas regen failed`, { err });
    }
  }

  async readCanvas(): Promise<unknown> {
    try {
      const raw = await readFile(join(this.rootPath, '.strada/vault/graph.canvas'), 'utf8');
      return JSON.parse(raw);
    } catch { return { nodes: [], edges: [] }; }
  }

  private async fullIndex(): Promise<void> {
    // Walk the Obsidian vault directory directly.
    const { readdir, lstat } = await import('node:fs/promises');
    const files: VaultFile[] = [];

    async function walk(dir: string, out: VaultFile[]): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full, out);
        } else if (e.isFile()) {
          const lang = EXT_LANG[e.name.slice(e.name.lastIndexOf('.')).toLowerCase()];
          if (!lang) continue;
          const st = await lstat(full);
          out.push({
            path: relative(dir, full).replace(/\\/g, '/'),
            blobHash: '', mtimeMs: st.mtimeMs, size: st.size,
            lang, kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
            indexedAt: 0,
          });
        }
      }
    }

    await walk(this.rootPath, files);

    const changed: string[] = [];
    for (const f of files) {
      if (await this.reindexFile(f.path)) changed.push(f.path);
    }
    await this.resolveWikilinks();
    await this.regenerateCanvas();
    if (changed.length) {
      this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
    }
  }

  private async reindexChanged(): Promise<number> {
    const before = new Set(this.store.listFiles().map((f) => f.path));
    const { readdir, lstat } = await import('node:fs/promises');
    const files: VaultFile[] = [];

    async function walk(dir: string, root: string, out: VaultFile[]): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full, root, out);
        } else if (e.isFile()) {
          const lang = EXT_LANG[e.name.slice(e.name.lastIndexOf('.')).toLowerCase()];
          if (!lang) continue;
          const st = await lstat(full);
          out.push({
            path: relative(root, full).replace(/\\/g, '/'),
            blobHash: '', mtimeMs: st.mtimeMs, size: st.size,
            lang, kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
            indexedAt: 0,
          });
        }
      }
    }

    await walk(this.rootPath, this.rootPath, files);

    const changed: string[] = [];
    for (const f of files) {
      if (await this.reindexFile(f.path)) changed.push(f.path);
    }
    const present = new Set(files.map((f) => f.path));
    for (const p of before) {
      if (!present.has(p)) {
        const hnswIds = this.store.listHnswIdsForPath(p);
        for (const hnswId of hnswIds) this.adapter.remove(hnswId);
        this.store.deleteFile(p);
        changed.push(p);
      }
    }
    return changed.length;
  }
}
