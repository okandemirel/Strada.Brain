import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SqliteVaultStore } from './sqlite-vault-store.js';
import { chunkFile } from './chunker.js';
import { xxhash64Hex } from './hash.js';
import { EmbeddingAdapter, type EmbeddingProvider, type VectorStore } from './embedding-adapter.js';
import { rrfFuse, packByBudget } from './query-pipeline.js';
import { listIndexableFiles } from './discovery.js';
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

function escapeFtsQuery(q: string): string {
  const safe = q.replace(/["*:()]/g, ' ').trim();
  if (!safe) return '""';
  return `"${safe}"`;
}

function inferLang(path: string): VaultFile['lang'] {
  if (path.endsWith('.cs')) return 'csharp';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.hlsl') || path.endsWith('.shader') || path.endsWith('.cginc')) return 'hlsl';
  return 'unknown';
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
    const chunks = fused
      .map((f) => this.store.getChunk(f.chunkId))
      .filter((c): c is VaultChunk => c !== null);
    const budget = q.budgetTokens ?? Number.POSITIVE_INFINITY;
    const { kept } = packByBudget(chunks, budget);
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
      truncated: kept.length < chunks.length,
    };
  }

  async stats(): Promise<VaultStats> {
    const files = this.store.listFiles();
    const chunkCount = this.store.chunkCount();
    let lastIndexedAt: number | null = null;
    for (const f of files) {
      if (lastIndexedAt === null || f.indexedAt > lastIndexedAt) lastIndexedAt = f.indexedAt;
    }
    const fsMod = await import('node:fs/promises');
    const st = await fsMod.stat(this.dbPath).catch(() => null);
    return { fileCount: files.length, chunkCount, lastIndexedAt, dbBytes: st?.size ?? 0 };
  }

  listFiles(): VaultFile[] { return this.store.listFiles(); }

  async readFile(relPath: string): Promise<string> {
    return await readFile(join(this.rootPath, relPath), 'utf8');
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
      // watcher.ts is a Task 9 file not yet created — suppress missing-module error intentionally.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error Task 9 file not yet created
      const mod = await import('./watcher.js') as { VaultWatcher: typeof WatcherCtor };
      WatcherCtor = mod.VaultWatcher;
    } catch {
      throw new Error('VaultWatcher not available — watcher.ts is not yet implemented (Task 9)');
    }
    this.watcher = new WatcherCtor({
      root: this.rootPath,
      debounceMs,
      onBatch: async (paths) => {
        const changed: string[] = [];
        for (const p of paths) if (await this.reindexFile(p)) changed.push(p);
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
    const st = await stat(abs);
    const hash = xxhash64Hex(body);
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
    const files = await listIndexableFiles(this.rootPath);
    const changed: string[] = [];
    for (const f of files) {
      const body = await readFile(join(this.rootPath, f.path), 'utf8');
      const hash = xxhash64Hex(body);
      const existing = this.store.getFile(f.path);
      if (existing?.blobHash === hash) continue;
      await this.reindexFile(f.path);
      changed.push(f.path);
    }
    const existingPaths = new Set(this.store.listFiles().map((f) => f.path));
    const presentPaths = new Set(files.map((f) => f.path));
    for (const p of existingPaths) {
      if (!presentPaths.has(p)) { this.store.deleteFile(p); changed.push(p); }
    }
    if (changed.length) this.emitter.emit('update', { vaultId: this.id, changedPaths: changed });
    return changed.length;
  }
}
