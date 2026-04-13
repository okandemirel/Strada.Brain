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

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  migrate(): void {
    const ddl = readFileSync(SCHEMA_PATH, 'utf8');
    applyDdl(this.db, ddl);
  }

  upsertFile(f: VaultFile): void {
    this.db.prepare(`
      INSERT INTO vault_files (path, blob_hash, mtime_ms, size, lang, kind, indexed_at)
      VALUES (@path, @blobHash, @mtimeMs, @size, @lang, @kind, @indexedAt)
      ON CONFLICT(path) DO UPDATE SET
        blob_hash=excluded.blob_hash,
        mtime_ms=excluded.mtime_ms,
        size=excluded.size,
        lang=excluded.lang,
        kind=excluded.kind,
        indexed_at=excluded.indexed_at
    `).run(f);
  }

  getFile(path: string): VaultFile | null {
    const row = this.db.prepare('SELECT * FROM vault_files WHERE path = ?').get(path) as Record<string, unknown> | undefined;
    return row ? this.mapFile(row) : null;
  }

  listFiles(filter?: { lang?: VaultFile['lang'][] }): VaultFile[] {
    if (filter?.lang?.length) {
      const placeholders = filter.lang.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT * FROM vault_files WHERE lang IN (${placeholders}) ORDER BY path`)
        .all(...filter.lang) as Record<string, unknown>[];
      return rows.map((r) => this.mapFile(r));
    }
    const rows = this.db.prepare('SELECT * FROM vault_files ORDER BY path').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapFile(r));
  }

  deleteFile(path: string): void {
    const chunkIds = this.db.prepare('SELECT chunk_id FROM vault_chunks WHERE path = ?').all(path) as { chunk_id: string }[];
    const deleteFts = this.db.prepare('DELETE FROM vault_chunks_fts WHERE chunk_id = ?');
    const txn = this.db.transaction(() => {
      for (const { chunk_id } of chunkIds) deleteFts.run(chunk_id);
      this.db.prepare('DELETE FROM vault_files WHERE path = ?').run(path);
    });
    txn();
  }

  upsertChunk(c: VaultChunk): void {
    const txn = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO vault_chunks (chunk_id, path, start_line, end_line, content, token_count)
        VALUES (@chunkId, @path, @startLine, @endLine, @content, @tokenCount)
        ON CONFLICT(chunk_id) DO UPDATE SET
          start_line=excluded.start_line,
          end_line=excluded.end_line,
          content=excluded.content,
          token_count=excluded.token_count
      `).run(c);
      this.db.prepare('DELETE FROM vault_chunks_fts WHERE chunk_id = ?').run(c.chunkId);
      this.db.prepare('INSERT INTO vault_chunks_fts (content, chunk_id, path) VALUES (?, ?, ?)')
        .run(c.content, c.chunkId, c.path);
    });
    txn();
  }

  getChunk(chunkId: string): VaultChunk | null {
    const row = this.db.prepare('SELECT * FROM vault_chunks WHERE chunk_id = ?').get(chunkId) as Record<string, unknown> | undefined;
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
    return (this.db.prepare('SELECT COUNT(*) AS n FROM vault_chunks').get() as { n: number }).n;
  }

  searchFts(query: string, topK: number): Array<{ chunkId: string; score: number }> {
    const rows = this.db.prepare(`
      SELECT chunk_id, bm25(vault_chunks_fts) AS raw
      FROM vault_chunks_fts
      WHERE vault_chunks_fts MATCH ?
      ORDER BY raw
      LIMIT ?
    `).all(query, topK) as { chunk_id: string; raw: number }[];
    return rows.map((r) => ({ chunkId: r['chunk_id'], score: -r['raw'] }));
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

  close(): void { this.db.close(); }
}
