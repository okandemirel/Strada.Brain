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
 * The record is a row instead, and — since round 9 #24 — the row owns the
 * BYTES rather than a path somebody else can change underneath it:
 *
 *   - a file up to `maxInlineBytes` (8 MiB by default) is SNAPSHOT into the
 *     row at registration, so deleting, overwriting or symlinking the original
 *     path cannot change, hide or redirect what the link serves;
 *   - a larger file stays a reference — copying a 2 GB recording into SQLite
 *     is not an improvement — but its exact size and SHA-256 are recorded at
 *     registration and re-checked before it is served, so the token serves the
 *     file it was issued for or nothing at all;
 *   - the reference is the REAL path (symlinks resolved once, here), so a
 *     symlink swapped in later cannot point an old token at a private file;
 *   - a path that could not be read at registration has no checksum and is
 *     never served.
 *
 * Retention is the token's: rows expire with the same TTL and the same bound on
 * how many are kept, and the snapshot dies with the row.
 */
import Database from "better-sqlite3";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";

/** Files up to this size are copied into the row; larger ones stay references. */
export const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface StoredAttachment {
  readonly token: string;
  readonly name: string;
  readonly mimeType?: string;
  /**
   * A file too large to snapshot, by its real path. Only servable while
   * `verifyStoredFile` still recognises it; a small attachment has `data`
   * instead and no path at all.
   */
  readonly path?: string;
  /** The bytes themselves: what was attached, as it was at registration. */
  readonly data?: Buffer;
  readonly chatId?: string;
  /** Size measured at registration (both forms). */
  readonly sizeBytes?: number;
  /** SHA-256 measured at registration (both forms). */
  readonly checksum?: string;
  readonly expiresAt: number;
}

export interface AttachmentToStore {
  readonly name: string;
  readonly mimeType?: string;
  readonly path?: string;
  readonly data?: Buffer;
  readonly chatId?: string;
}

/** SHA-256 of a file, read in chunks so a huge file does not land in memory. */
function hashFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

interface AttachmentSnapshot {
  path: string | null;
  data: Buffer | null;
  sizeBytes: number | null;
  checksum: string | null;
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
    private readonly maxInlineBytes: number = DEFAULT_MAX_INLINE_ATTACHMENT_BYTES,
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
        expires_at INTEGER NOT NULL,
        byte_size INTEGER,
        checksum TEXT
      )
    `);
    // A database written before round 9 #24 has neither column; its existing
    // rows keep a path with no checksum, which is simply never served.
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(web_attachments)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!columns.has("byte_size")) this.db.exec("ALTER TABLE web_attachments ADD COLUMN byte_size INTEGER");
    if (!columns.has("checksum")) this.db.exec("ALTER TABLE web_attachments ADD COLUMN checksum TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_web_attachments_expiry ON web_attachments(expires_at)");

    this.stmtInsert = this.db.prepare(
      `INSERT INTO web_attachments (token, name, mime_type, path, data, chat_id, created_at, expires_at, byte_size, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGet = this.db.prepare("SELECT * FROM web_attachments WHERE token = ?");
    this.stmtDeleteExpired = this.db.prepare("DELETE FROM web_attachments WHERE expires_at <= ?");
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS n FROM web_attachments");
    this.stmtDeleteOldest = this.db.prepare(
      "DELETE FROM web_attachments WHERE token IN (SELECT token FROM web_attachments ORDER BY created_at ASC LIMIT ?)",
    );
  }

  /**
   * What the token will own. Bytes are taken here, once, while the caller still
   * vouches for the file — never at serve time, when the path may name
   * something else entirely (round 9 #24).
   */
  private snapshot(attachment: AttachmentToStore): AttachmentSnapshot {
    if (attachment.data) {
      return {
        path: null,
        data: attachment.data,
        sizeBytes: attachment.data.length,
        checksum: createHash("sha256").update(attachment.data).digest("hex"),
      };
    }
    const source = attachment.path;
    if (!source) return { path: null, data: null, sizeBytes: null, checksum: null };
    try {
      // Resolved ONCE, here: a symlink swapped in afterwards cannot redirect
      // an existing token.
      const real = realpathSync(source);
      const info = statSync(real);
      if (!info.isFile()) return { path: real, data: null, sizeBytes: null, checksum: null };
      if (info.size <= this.maxInlineBytes) {
        const data = readFileSync(real);
        return {
          path: null,
          data,
          sizeBytes: data.length,
          checksum: createHash("sha256").update(data).digest("hex"),
        };
      }
      return { path: real, data: null, sizeBytes: info.size, checksum: hashFile(real) };
    } catch {
      // Unreadable at registration: the path is kept so diagnostics can say
      // what was promised, and with no checksum it is never served.
      return { path: source, data: null, sizeBytes: null, checksum: null };
    }
  }

  /** Register a file or bytes and return the token the link uses. */
  register(attachment: AttachmentToStore): string {
    const now = Date.now();
    this.stmtDeleteExpired.run(now);
    const count = (this.stmtCount.get() as { n: number }).n;
    const over = count - (this.maxEntries - 1);
    if (over > 0) this.stmtDeleteOldest.run(over);
    const token = randomBytes(18).toString("base64url");
    const snapshot = this.snapshot(attachment);
    this.stmtInsert.run(
      token, attachment.name, attachment.mimeType ?? null, snapshot.path,
      snapshot.data, attachment.chatId ?? null, now, now + this.ttlMs,
      snapshot.sizeBytes, snapshot.checksum,
    );
    return token;
  }

  /** The record behind a token, or null when it is unknown or expired. */
  get(token: string): StoredAttachment | null {
    const row = this.stmtGet.get(token) as
      | {
          token: string; name: string; mime_type: string | null; path: string | null; data: Buffer | null;
          chat_id: string | null; expires_at: number; byte_size: number | null; checksum: string | null;
        }
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
      ...(row.byte_size === null ? {} : { sizeBytes: row.byte_size }),
      ...(row.checksum === null ? {} : { checksum: row.checksum }),
      expiresAt: row.expires_at,
    };
  }

  /**
   * Whether the file behind a by-reference record is still EXACTLY what was
   * registered: a regular file (not a directory, device, or symlink that
   * appeared later) of the recorded size with the recorded SHA-256. A record
   * with no checksum — one whose bytes were never captured, including rows
   * written before round 9 #24 — is never servable.
   */
  verifyStoredFile(entry: StoredAttachment): boolean {
    if (!entry.path || entry.checksum === undefined || entry.sizeBytes === undefined) return false;
    try {
      const info = lstatSync(entry.path);
      if (!info.isFile() || info.size !== entry.sizeBytes) return false;
      return hashFile(entry.path) === entry.checksum;
    } catch {
      return false;
    }
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
