import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { EventEmitter } from 'node:events';
import { SqliteVaultStore } from './sqlite-vault-store.js';
import { chunkFile } from './chunker.js';
import { xxhash64Hex } from './hash.js';
import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from './embedding-adapter.js';
import { rrfFuse, packByBudget } from './query-pipeline.js';
import { EXT_LANG, listIndexableFiles } from './discovery.js';
import type {
  IVault, VaultFile, VaultQuery, VaultQueryResult, VaultStats, VaultId, VaultChunk,
} from './vault.interface.js';

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

// Strip FTS5 special operators AND boolean keywords that could confuse the parser.
function escapeFtsQuery(q: string): string {
  const stripped = q.replace(/["*:()^+\-]/g, ' ').replace(/\b(NOT|AND|OR|NEAR)\b/g, ' ').trim();
  if (!stripped) return '""';
  return `"${stripped}"`;
}

function inferLang(path: string): VaultFile['lang'] {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return EXT_LANG[ext] ?? 'unknown';
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
  readonly kind = 'unity-project' as const;
  readonly rootPath: string;
  private store: SqliteVaultStore;
  private adapter: EmbeddingAdapter;
  private emitter = new EventEmitter();
  private dbPath: string;
  private watcher: IVaultWatcher | null = null;

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
    await mkdir(join(this.rootPath, '.strada/vault/codebase'), { recursive: true });
    this.store.migrate();
    await this.fullIndex();
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
    let chunks = fused
      .map((f) => this.store.getChunk(f.chunkId))
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
    return { fileCount: files.length, chunkCount, lastIndexedAt, dbBytes: st?.size ?? 0 };
  }

  listFiles(): VaultFile[] { return this.store.listFiles(); }

  async readFile(relPath: string): Promise<string> {
    // Fix SecC1: confine to vault root — reject anything that resolves outside.
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
            console.warn(`[vault ${this.id}] reindexFile failed for ${p}:`, err);
          }
        }
        if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
      },
    });
    await this.watcher.start();
  }

  async stopWatch(): Promise<void> {
    if (this.watcher) { await this.watcher.stop(); this.watcher = null; }
  }

  async dispose(): Promise<void> {
    await this.stopWatch();
    this.store.close();
  }

  async reindexFile(relPath: string): Promise<boolean> {
    const abs = join(this.rootPath, relPath);
    const body = await readFile(abs, 'utf8').catch(() => null);
    if (body === null) { this.store.deleteFile(relPath); return true; }
    const hash = xxhash64Hex(body);
    const existing = this.store.getFile(relPath);
    if (existing?.blobHash === hash) return false;  // Fix C1: short-circuit on unchanged hash
    const st = await stat(abs);
    const lang = inferLang(relPath);
    this.store.deleteFile(relPath);
    this.store.upsertFile({
      path: relPath, blobHash: hash, mtimeMs: st.mtimeMs, size: st.size,
      lang, kind: lang === 'markdown' ? 'doc' : lang === 'json' ? 'config' : 'source',
      indexedAt: Date.now(),
    });
    const chunks = chunkFile({ path: relPath, content: body, lang });
    for (const c of chunks) this.store.upsertChunk(c);
    await this.adapter.upsertBatch(chunks.map((c) => ({ chunkId: c.chunkId, content: c.content })));
    return true;
  }

  private async fullIndex(): Promise<void> {
    const files = await listIndexableFiles(this.rootPath);
    const changed: string[] = [];
    for (const f of files) if (await this.reindexFile(f.path)) changed.push(f.path);
    if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
  }

  private async reindexChanged(): Promise<number> {
    // Fix CodeRevC1: capture the pre-scan state of the DB BEFORE we reindex,
    // so deletion detection compares apples to apples even if reindexFile mutates store mid-loop.
    const before = new Set(this.store.listFiles().map((f) => f.path));
    const files = await listIndexableFiles(this.rootPath);
    const changed: string[] = [];
    for (const f of files) {
      if (await this.reindexFile(f.path)) changed.push(f.path);
    }
    const present = new Set(files.map((f) => f.path));
    for (const p of before) {
      if (!present.has(p)) { this.store.deleteFile(p); changed.push(p); }
    }
    if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
    return changed.length;
  }
}
