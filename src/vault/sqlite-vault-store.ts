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
  private _stmtListWikilinksTo: Database.Statement | null = null;
  private _stmtMarkWikilinkResolved: Database.Statement | null = null;
  private _stmtDeleteWikilinksFromNote: Database.Statement | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  migrate(): void {
    const ddl = readFileSync(SCHEMA_PATH, 'utf8');
    applyDdl(this.db, ddl);
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
    this._stmtListWikilinksTo = this.db.prepare('SELECT * FROM vault_wikilinks WHERE target = ?');
    this._stmtMarkWikilinkResolved = this.db.prepare('UPDATE vault_wikilinks SET resolved = 1 WHERE from_note = ? AND target = ?');
    this._stmtDeleteWikilinksFromNote = this.db.prepare('DELETE FROM vault_wikilinks WHERE from_note = ?');
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

  listWikilinksTo(target: string): VaultWikilink[] {
    const rows = this._stmtListWikilinksTo!.all(target) as Record<string, unknown>[];
    return rows.map((r) => ({
      fromNote: r['from_note'] as string,
      target: r['target'] as string,
      resolved: (r['resolved'] as number) === 1,
    }));
  }

  markWikilinkResolved(fromNote: string, target: string): void {
    this._stmtMarkWikilinkResolved!.run(fromNote, target);
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

  // Fix 4: idempotent close — no-op if already closed.
  close(): void {
    if (this.db.open) this.db.close();
  }
}
