/**
 * ATTACHMENTS THE PORTAL CAN STILL FETCH AFTER A RESTART (plan 2.8, the
 * durable form of 0-A.4).
 *
 * `sendAttachment` registered each file in a Map and handed the chat a
 * `/attachments/<token>` link. The Map died with the process, so every link in
 * the history — including the ones the reconnect replay re-sends — answered
 * 404 the moment the daemon restarted: the gameplay frame, the HOW_TO_RUN, the
 * recording were all gone while their messages still promised them.
 *
 * The record is a row instead: a local path (the daemon's own file, streamed on
 * demand) or the bytes themselves, with the same TTL and the same bound on how
 * many are kept.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";

export interface StoredAttachment {
  readonly token: string;
  readonly name: string;
  readonly mimeType?: string;
  /** A file the daemon holds; streamed when served. */
  readonly path?: string;
  /** The bytes themselves, when the attachment carried them. */
  readonly data?: Buffer;
  readonly chatId?: string;
  readonly expiresAt: number;
}

export interface AttachmentToStore {
  readonly name: string;
  readonly mimeType?: string;
  readonly path?: string;
  readonly data?: Buffer;
  readonly chatId?: string;
}

export class WebAttachmentStore {
  private readonly db: Database.Database;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtDeleteExpired: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtDeleteOldest: Database.Statement;

  constructor(
    dbPath: string = ":memory:",
    private readonly ttlMs: number = 24 * 60 * 60_000,
    private readonly maxEntries: number = 200,
  ) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    configureSqlitePragmas(this.db, "identity");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_attachments (
        token TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT,
        path TEXT,
        data BLOB,
        chat_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_web_attachments_expiry ON web_attachments(expires_at)");

    this.stmtInsert = this.db.prepare(
      `INSERT INTO web_attachments (token, name, mime_type, path, data, chat_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGet = this.db.prepare("SELECT * FROM web_attachments WHERE token = ?");
    this.stmtDeleteExpired = this.db.prepare("DELETE FROM web_attachments WHERE expires_at <= ?");
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS n FROM web_attachments");
    this.stmtDeleteOldest = this.db.prepare(
      "DELETE FROM web_attachments WHERE token IN (SELECT token FROM web_attachments ORDER BY created_at ASC LIMIT ?)",
    );
  }

  /** Register a file or bytes and return the token the link uses. */
  register(attachment: AttachmentToStore): string {
    const now = Date.now();
    this.stmtDeleteExpired.run(now);
    const count = (this.stmtCount.get() as { n: number }).n;
    const over = count - (this.maxEntries - 1);
    if (over > 0) this.stmtDeleteOldest.run(over);
    const token = randomBytes(18).toString("base64url");
    this.stmtInsert.run(
      token, attachment.name, attachment.mimeType ?? null, attachment.path ?? null,
      attachment.data ?? null, attachment.chatId ?? null, now, now + this.ttlMs,
    );
    return token;
  }

  /** The record behind a token, or null when it is unknown or expired. */
  get(token: string): StoredAttachment | null {
    const row = this.stmtGet.get(token) as
      | { token: string; name: string; mime_type: string | null; path: string | null; data: Buffer | null; chat_id: string | null; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.stmtDeleteExpired.run(Date.now());
      return null;
    }
    return {
      token: row.token,
      name: row.name,
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.path ? { path: row.path } : {}),
      ...(row.data ? { data: row.data } : {}),
      ...(row.chat_id ? { chatId: row.chat_id } : {}),
      expiresAt: row.expires_at,
    };
  }

  /** How many records are live (diagnostics / tests). */
  size(): number {
    this.stmtDeleteExpired.run(Date.now());
    return (this.stmtCount.get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
