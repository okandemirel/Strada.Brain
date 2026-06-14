import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { VaultFile, VaultChunk, VaultSymbol, VaultEdge, VaultWikilink } from './vault.interface.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

function applyDdl(db: Database.Database, sql: string): void {
  // Apply DDL statement-by-statement via prepared statements (avoids db.exec for security-hook compatibility).
  const cleaned = sql.replace(/--[^\n]*/g, '');
  const statements = cleaned.split(/;\s*(?=\n|$)/).map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) db.prepare(stmt).run();
}

export class SqliteVaultStore {
  private db: Database.Database;

  // Cached prepared statements (lazily initialized after migrate() ensures tables exist).
  private _stmtUpsertFile: Database.Statement | null = null;
  private _stmtGetFile: Database.Statement | null = null;
  private _stmtListFilesAll: Database.Statement | null = null;
  private _stmtDeleteFts: Database.Statement | null = null;
  private _stmtDeleteChunksByPath: Database.Statement | null = null;
  private _stmtDeleteFile: Database.Statement | null = null;
  private _stmtUpsertChunk: Database.Statement | null = null;
  private _stmtDeleteFtsById: Database.Statement | null = null;
  private _stmtInsertFts: Database.Statement | null = null;
  private _stmtGetChunk: Database.Statement | null = null;
  private _stmtChunkCount: Database.Statement | null = null;
  private _stmtSearchFts: Database.Statement | null = null;
  private _stmtUpsertSymbol: Database.Statement | null = null;
  private _stmtListSymbolsByPath: Database.Statement | null = null;
  private _stmtFindSymbolsByName: Database.Statement | null = null;
  private _stmtDeleteSymbolsByPath: Database.Statement | null = null;
  private _stmtUpsertEdge: Database.Statement | null = null;
  private _stmtFindCallers: Database.Statement | null = null;
  private _stmtListEdgesAll: Database.Statement | null = null;
  private _stmtDeleteEdgesByPath: Database.Statement | null = null;
  private _stmtUpsertWikilink: Database.Statement | null = null;
  private _stmtUpsertWikilinkResolved: Database.Statement | null = null;
  private _stmtListWikilinksAll: Database.Statement | null = null;
  private _stmtListWikilinksTo: Database.Statement | null = null;
  private _stmtMarkWikilinkResolved: Database.Statement | null = null;
  private _stmtDeleteWikilink: Database.Statement | null = null;
  private _stmtDeleteWikilinksFromNote: Database.Statement | null = null;
  private _stmtUpsertEmbedding: Database.Statement | null = null;
  private _stmtListHnswIdsForPath: Database.Statement | null = null;
  private _stmtUpsertFrontmatter: Database.Statement | null = null;
  private _stmtDeleteFrontmatterByPath: Database.Statement | null = null;
  private _stmtListFrontmatterByPath: Database.Statement | null = null;
  private _stmtUpsertTag: Database.Statement | null = null;
  private _stmtDeleteTagsByPath: Database.Statement | null = null;
  private _stmtListTagsByPath: Database.Statement | null = null;
  private _stmtFindPathsByTag: Database.Statement | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  migrate(): void {
    const ddl = readFileSync(SCHEMA_PATH, 'utf8');
    applyDdl(this.db, ddl);
    // Additive migration for pre-existing DBs: schema.sql uses CREATE TABLE IF
    // NOT EXISTS, so a new column isn't added to an already-created table. Guard
    // with PRAGMA so this is idempotent (new DBs already have the column).
    const wikilinkCols = this.db.prepare('PRAGMA table_info(vault_wikilinks)').all() as { name: string }[];
    if (!wikilinkCols.some((c) => c.name === 'original_target')) {
      this.db.prepare('ALTER TABLE vault_wikilinks ADD COLUMN original_target TEXT').run();
    }
    // Prepare cached statements now that tables exist.
    this._stmtUpsertFile = this.db.prepare(`
      INSERT INTO vault_files (path, blob_hash, mtime_ms, size, lang, kind, indexed_at)
      VALUES (@path, @blobHash, @mtimeMs, @size, @lang, @kind, @indexedAt)
      ON CONFLICT(path) DO UPDATE SET
        blob_hash=excluded.blob_hash,
        mtime_ms=excluded.mtime_ms,
        size=excluded.size,
        lang=excluded.lang,
        kind=excluded.kind,
        indexed_at=excluded.indexed_at
    `);
    this._stmtGetFile = this.db.prepare('SELECT * FROM vault_files WHERE path = ?');
    this._stmtListFilesAll = this.db.prepare('SELECT * FROM vault_files ORDER BY path');
    this._stmtDeleteFts = this.db.prepare('DELETE FROM vault_chunks_fts WHERE chunk_id = ?');
    this._stmtDeleteChunksByPath = this.db.prepare('SELECT chunk_id FROM vault_chunks WHERE path = ?');
    this._stmtDeleteFile = this.db.prepare('DELETE FROM vault_files WHERE path = ?');
    this._stmtUpsertChunk = this.db.prepare(`
      INSERT INTO vault_chunks (chunk_id, path, start_line, end_line, content, token_count)
      VALUES (@chunkId, @path, @startLine, @endLine, @content, @tokenCount)
      ON CONFLICT(chunk_id) DO UPDATE SET
        start_line=excluded.start_line,
        end_line=excluded.end_line,
        content=excluded.content,
        token_count=excluded.token_count
    `);
    this._stmtDeleteFtsById = this.db.prepare('DELETE FROM vault_chunks_fts WHERE chunk_id = ?');
    this._stmtInsertFts = this.db.prepare('INSERT INTO vault_chunks_fts (content, chunk_id, path) VALUES (?, ?, ?)');
    this._stmtGetChunk = this.db.prepare('SELECT * FROM vault_chunks WHERE chunk_id = ?');
    this._stmtChunkCount = this.db.prepare('SELECT COUNT(*) AS n FROM vault_chunks');
    this._stmtSearchFts = this.db.prepare(`
      SELECT chunk_id, bm25(vault_chunks_fts) AS raw
      FROM vault_chunks_fts
      WHERE vault_chunks_fts MATCH ?
      ORDER BY raw
      LIMIT ?
    `);
    this._stmtUpsertSymbol = this.db.prepare(`
      INSERT INTO vault_symbols (symbol_id, path, kind, name, display, start_line, end_line, doc)
      VALUES (@symbolId, @path, @kind, @name, @display, @startLine, @endLine, @doc)
      ON CONFLICT(symbol_id) DO UPDATE SET
        path=excluded.path, kind=excluded.kind, name=excluded.name, display=excluded.display,
        start_line=excluded.start_line, end_line=excluded.end_line, doc=excluded.doc
    `);
    this._stmtListSymbolsByPath = this.db.prepare('SELECT * FROM vault_symbols WHERE path = ? ORDER BY start_line');
    this._stmtFindSymbolsByName = this.db.prepare('SELECT * FROM vault_symbols WHERE name = ? ORDER BY path LIMIT ?');
    this._stmtDeleteSymbolsByPath = this.db.prepare('DELETE FROM vault_symbols WHERE path = ?');
    this._stmtUpsertEdge = this.db.prepare(`
      INSERT INTO vault_edges (from_symbol, to_symbol, kind, at_line)
      VALUES (@fromSymbol, @toSymbol, @kind, @atLine)
      ON CONFLICT(from_symbol, to_symbol, kind, at_line) DO NOTHING
    `);
    this._stmtFindCallers = this.db.prepare('SELECT * FROM vault_edges WHERE to_symbol = ?');
    this._stmtListEdgesAll = this.db.prepare('SELECT * FROM vault_edges');
    this._stmtDeleteEdgesByPath = this.db.prepare(`
      DELETE FROM vault_edges
      WHERE from_symbol IN (SELECT symbol_id FROM vault_symbols WHERE path = ?)
         OR to_symbol   IN (SELECT symbol_id FROM vault_symbols WHERE path = ?)
    `);
    this._stmtUpsertWikilink = this.db.prepare(`
      INSERT INTO vault_wikilinks (from_note, target, resolved)
      VALUES (@fromNote, @target, @resolved)
      ON CONFLICT(from_note, target) DO UPDATE SET resolved = excluded.resolved
    `);
    // Insert a resolved row keyed by the resolved path, preserving the raw
    // authored token in original_target. COALESCE keeps a previously-stored
    // token on conflict (don't clobber it with a later resolved-path token).
    this._stmtUpsertWikilinkResolved = this.db.prepare(`
      INSERT INTO vault_wikilinks (from_note, target, original_target, resolved)
      VALUES (@fromNote, @target, @originalTarget, 1)
      ON CONFLICT(from_note, target) DO UPDATE SET
        original_target = COALESCE(vault_wikilinks.original_target, excluded.original_target),
        resolved = 1
    `);
    this._stmtListWikilinksAll = this.db.prepare('SELECT * FROM vault_wikilinks');
    this._stmtListWikilinksTo = this.db.prepare('SELECT * FROM vault_wikilinks WHERE target = ?');
    this._stmtMarkWikilinkResolved = this.db.prepare('UPDATE vault_wikilinks SET resolved = 1 WHERE from_note = ? AND target = ?');
    this._stmtDeleteWikilink = this.db.prepare('DELETE FROM vault_wikilinks WHERE from_note = ? AND target = ?');
    this._stmtDeleteWikilinksFromNote = this.db.prepare('DELETE FROM vault_wikilinks WHERE from_note = ?');
    this._stmtUpsertEmbedding = this.db.prepare(`
      INSERT INTO vault_embeddings (chunk_id, hnsw_id, dim, model)
      VALUES (@chunkId, @hnswId, @dim, @model)
      ON CONFLICT(chunk_id) DO UPDATE SET
        hnsw_id=excluded.hnsw_id,
        dim=excluded.dim,
        model=excluded.model
    `);
    this._stmtListHnswIdsForPath = this.db.prepare(`
      SELECT hnsw_id FROM vault_embeddings
      WHERE chunk_id IN (SELECT chunk_id FROM vault_chunks WHERE path = ?)
    `);
    this._stmtUpsertFrontmatter = this.db.prepare(`
      INSERT INTO vault_frontmatter (path, key, value)
      VALUES (@path, @key, @value)
      ON CONFLICT(path, key) DO UPDATE SET value = excluded.value
    `);
    this._stmtDeleteFrontmatterByPath = this.db.prepare('DELETE FROM vault_frontmatter WHERE path = ?');
    this._stmtListFrontmatterByPath = this.db.prepare('SELECT key, value FROM vault_frontmatter WHERE path = ?');
    this._stmtUpsertTag = this.db.prepare(`
      INSERT INTO vault_tags (path, tag)
      VALUES (@path, @tag)
      ON CONFLICT(path, tag) DO NOTHING
    `);
    this._stmtDeleteTagsByPath = this.db.prepare('DELETE FROM vault_tags WHERE path = ?');
    this._stmtListTagsByPath = this.db.prepare('SELECT tag FROM vault_tags WHERE path = ?');
    this._stmtFindPathsByTag = this.db.prepare('SELECT path FROM vault_tags WHERE tag = ?');
  }

  upsertFile(f: VaultFile): void {
    this._stmtUpsertFile!.run(f);
  }

  getFile(path: string): VaultFile | null {
    const row = this._stmtGetFile!.get(path) as Record<string, unknown> | undefined;
    return row ? this.mapFile(row) : null;
  }

  listFiles(filter?: { lang?: VaultFile['lang'][] }): VaultFile[] {
    if (filter?.lang?.length) {
      // Statement varies by # of placeholders; keep inline (acceptable variance per design).
      const placeholders = filter.lang.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT * FROM vault_files WHERE lang IN (${placeholders}) ORDER BY path`)
        .all(...filter.lang) as Record<string, unknown>[];
      return rows.map((r) => this.mapFile(r));
    }
    const rows = this._stmtListFilesAll!.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapFile(r));
  }

  deleteFile(path: string): void {
    // Fix 1 (TOCTOU): SELECT chunk_ids inside the transaction so it sees the same snapshot as the writes.
    const txn = this.db.transaction(() => {
      // Phase 2: edges have a non-FK to_symbol — drop edges originating in OR pointing AT this
      // file's symbols before removing the symbols themselves, so other files' edges can't
      // orphan-reference a removed target (phase2-review C2).
      this._stmtDeleteEdgesByPath!.run(path, path);
      this._stmtDeleteSymbolsByPath!.run(path);
      this._stmtDeleteWikilinksFromNote!.run(path);
      const chunkIds = this._stmtDeleteChunksByPath!.all(path) as { chunk_id: string }[];
      for (const { chunk_id } of chunkIds) this._stmtDeleteFts!.run(chunk_id);
      this._stmtDeleteFile!.run(path);
    });
    txn();
  }

  upsertChunk(c: VaultChunk): void {
    const txn = this.db.transaction(() => {
      this._stmtUpsertChunk!.run(c);
      this._stmtDeleteFtsById!.run(c.chunkId);
      this._stmtInsertFts!.run(c.content, c.chunkId, c.path);
    });
    txn();
  }

  getChunk(chunkId: string): VaultChunk | null {
    const row = this._stmtGetChunk!.get(chunkId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chunkId: row['chunk_id'] as string,
      path: row['path'] as string,
      startLine: row['start_line'] as number,
      endLine: row['end_line'] as number,
      content: row['content'] as string,
      tokenCount: row['token_count'] as number,
    };
  }

  chunkCount(): number {
    return (this._stmtChunkCount!.get() as { n: number }).n;
  }

  symbolCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM vault_symbols').get() as { n: number }).n;
  }

  /**
   * Full-text search via FTS5 BM25.
   * @returns hits sorted by relevance, with `score > 0` where higher = more relevant
   *          (raw BM25 returns negative-where-best; we negate so callers can sort descending).
   */
  searchFts(query: string, topK: number): Array<{ chunkId: string; score: number }> {
    // CodeRevC2: FTS5 throws on malformed queries — swallow and return [] so the wider
    // hybrid query() path doesn't unwind on a user's odd search input.
    try {
      const rows = this._stmtSearchFts!.all(query, topK) as { chunk_id: string; raw: number }[];
      return rows.map((r) => ({ chunkId: r['chunk_id'], score: -r['raw'] }));
    } catch {
      return [];
    }
  }

  private mapFile(row: Record<string, unknown>): VaultFile {
    return {
      path: row['path'] as string,
      blobHash: row['blob_hash'] as string,
      mtimeMs: row['mtime_ms'] as number,
      size: row['size'] as number,
      lang: row['lang'] as VaultFile['lang'],
      kind: row['kind'] as VaultFile['kind'],
      indexedAt: row['indexed_at'] as number,
    };
  }

  upsertSymbol(s: VaultSymbol): void { this._stmtUpsertSymbol!.run(s); }

  listSymbolsForPath(path: string): VaultSymbol[] {
    const rows = this._stmtListSymbolsByPath!.all(path) as Record<string, unknown>[];
    return rows.map(this.mapSymbol);
  }

  findSymbolsByName(name: string, limit = 20): VaultSymbol[] {
    const rows = this._stmtFindSymbolsByName!.all(name, limit) as Record<string, unknown>[];
    return rows.map(this.mapSymbol);
  }

  upsertEdge(e: VaultEdge): void { this._stmtUpsertEdge!.run(e); }

  findCallersOf(symbolId: string): VaultEdge[] {
    const rows = this._stmtFindCallers!.all(symbolId) as Record<string, unknown>[];
    return rows.map(this.mapEdge);
  }

  listEdges(): VaultEdge[] {
    const rows = this._stmtListEdgesAll!.all() as Record<string, unknown>[];
    return rows.map(this.mapEdge);
  }

  upsertWikilink(w: VaultWikilink): void {
    this._stmtUpsertWikilink!.run({ ...w, resolved: w.resolved ? 1 : 0 });
  }

  listWikilinks(): VaultWikilink[] {
    const rows = this._stmtListWikilinksAll!.all() as Record<string, unknown>[];
    return rows.map((r) => ({
      fromNote: r['from_note'] as string,
      target: r['target'] as string,
      resolved: (r['resolved'] as number) === 1,
      originalTarget: (r['original_target'] as string | null) ?? null,
    }));
  }

  listWikilinksTo(target: string): VaultWikilink[] {
    const rows = this._stmtListWikilinksTo!.all(target) as Record<string, unknown>[];
    return rows.map((r) => ({
      fromNote: r['from_note'] as string,
      target: r['target'] as string,
      resolved: (r['resolved'] as number) === 1,
      originalTarget: (r['original_target'] as string | null) ?? null,
    }));
  }

  markWikilinkResolved(fromNote: string, target: string): void {
    this._stmtMarkWikilinkResolved!.run(fromNote, target);
  }

  /**
   * Re-key a wikilink row from `oldTarget` to the resolved `newTarget`, storing
   * `originalToken` (the raw authored token, e.g. "B") in original_target so a
   * later target rename can re-resolve from it instead of the now-stale path.
   */
  updateWikilinkTarget(fromNote: string, oldTarget: string, newTarget: string, originalToken: string): void {
    const txn = this.db.transaction(() => {
      this._stmtDeleteWikilink!.run(fromNote, oldTarget);
      this._stmtUpsertWikilinkResolved!.run({ fromNote, target: newTarget, originalTarget: originalToken });
    });
    txn();
  }

  private mapSymbol = (row: Record<string, unknown>): VaultSymbol => ({
    symbolId: row['symbol_id'] as string,
    path: row['path'] as string,
    kind: row['kind'] as VaultSymbol['kind'],
    name: row['name'] as string,
    display: row['display'] as string,
    startLine: row['start_line'] as number,
    endLine: row['end_line'] as number,
    doc: (row['doc'] as string | null) ?? null,
  });

  private mapEdge = (row: Record<string, unknown>): VaultEdge => ({
    fromSymbol: row['from_symbol'] as string,
    toSymbol: row['to_symbol'] as string,
    kind: row['kind'] as VaultEdge['kind'],
    atLine: row['at_line'] as number,
  });

  listTableNamesForTest(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  upsertEmbedding(chunkId: string, hnswId: number, dim: number, model: string): void {
    this._stmtUpsertEmbedding!.run({ chunkId, hnswId, dim, model });
  }

  listHnswIdsForPath(path: string): number[] {
    const rows = this._stmtListHnswIdsForPath!.all(path) as { hnsw_id: number }[];
    return rows.map((r) => r.hnsw_id);
  }

  // Frontmatter & Tags
  upsertFrontmatter(path: string, key: string, value: string): void {
    this._stmtUpsertFrontmatter!.run({ path, key, value });
  }

  deleteFrontmatterByPath(path: string): void {
    this._stmtDeleteFrontmatterByPath!.run(path);
  }

  listFrontmatterByPath(path: string): Record<string, string> {
    const rows = this._stmtListFrontmatterByPath!.all(path) as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  upsertTag(path: string, tag: string): void {
    this._stmtUpsertTag!.run({ path, tag });
  }

  deleteTagsByPath(path: string): void {
    this._stmtDeleteTagsByPath!.run(path);
  }

  listTagsByPath(path: string): string[] {
    const rows = this._stmtListTagsByPath!.all(path) as { tag: string }[];
    return rows.map((r) => r.tag);
  }

  findPathsByTag(tag: string): string[] {
    const rows = this._stmtFindPathsByTag!.all(tag) as { path: string }[];
    return rows.map((r) => r.path);
  }

  // Fix 4: idempotent close — no-op if already closed.
  close(): void {
    if (this.db.open) this.db.close();
  }

  /**
   * Atomic reindex transaction (P1 fix).
   *
   * Wraps the delete-old + upsert-file + upsert-chunks + upsert-symbols + edges
   * + wikilinks + frontmatter + tags sequence in a single SQLite transaction so
   * a partial extractor failure cannot leave half-written data visible to
   * concurrent readers.
   *
   * NOTE: embedding upserts (HNSW external index) are NOT in this transaction —
   * caller must commit HNSW changes AFTER this returns ok and roll them back
   * (by deleting the chunks) if HNSW commit fails.
   */
  runReindexTxn(input: {
    path: string;
    file: VaultFile;
    chunks: VaultChunk[];
    symbols: VaultSymbol[];
    edges: VaultEdge[];
    wikilinks: VaultWikilink[];
    frontmatter: Record<string, string> | null;
    tags: string[] | null;
  }): { ok: true } | { ok: false; error: string } {
    try {
      const txn = this.db.transaction(() => {
        // 1) Drop the file row (and cascade chunks/symbols/edges/wikilinks via deleteFile).
        //    Inlined to avoid nested transactions (better-sqlite3 supports nesting but we
        //    keep it explicit here for clarity).
        this._stmtDeleteEdgesByPath!.run(input.path, input.path);
        this._stmtDeleteSymbolsByPath!.run(input.path);
        this._stmtDeleteWikilinksFromNote!.run(input.path);
        const chunkIds = this._stmtDeleteChunksByPath!.all(input.path) as { chunk_id: string }[];
        for (const { chunk_id } of chunkIds) this._stmtDeleteFts!.run(chunk_id);
        this._stmtDeleteFile!.run(input.path);

        // 2) Upsert file row.
        this._stmtUpsertFile!.run(input.file);

        // 3) Upsert chunks + FTS.
        for (const c of input.chunks) {
          this._stmtUpsertChunk!.run(c);
          this._stmtDeleteFtsById!.run(c.chunkId);
          this._stmtInsertFts!.run(c.content, c.chunkId, c.path);
        }

        // 4) Symbols, edges, wikilinks.
        for (const s of input.symbols) this._stmtUpsertSymbol!.run(s);
        for (const e of input.edges) this._stmtUpsertEdge!.run(e);
        for (const w of input.wikilinks) {
          this._stmtUpsertWikilink!.run({ ...w, resolved: w.resolved ? 1 : 0 });
        }

        // 5) Frontmatter & tags (full-replace semantics).
        if (input.frontmatter) {
          this._stmtDeleteFrontmatterByPath!.run(input.path);
          for (const [key, value] of Object.entries(input.frontmatter)) {
            this._stmtUpsertFrontmatter!.run({ path: input.path, key, value });
          }
        }
        if (input.tags) {
          this._stmtDeleteTagsByPath!.run(input.path);
          for (const tag of input.tags) {
            this._stmtUpsertTag!.run({ path: input.path, tag });
          }
        }
      });
      txn();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}
