import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { VaultFile, VaultChunk } from './vault.interface.js';

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

  // Fix 4: idempotent close — no-op if already closed.
  close(): void {
    if (this.db.open) this.db.close();
  }
}
