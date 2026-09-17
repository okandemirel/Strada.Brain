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
 * BYTES rather than a path somebody else can change underneath it. Round 10 #2
 * finished that for the large files:
 *
 *   - a file up to `maxInlineBytes` (8 MiB by default) is SNAPSHOT into the
 *     row at registration, so deleting, overwriting or symlinking the original
 *     path cannot change, hide or redirect what the link serves;
 *   - a LARGER file is not copied into SQLite (a 2 GB recording in a row is not
 *     an improvement) but it is still RETAINED: an immutable private copy is
 *     made under the store's own spool directory (0700, the copy 0600) and the
 *     token names that copy, not the caller's temp file. Deleting the temp
 *     source — which is what a recording pipeline does the moment it is done —
 *     no longer 404s a live token, and a file swapped in at the source path
 *     cannot be served in place of the bytes the link promised;
 *   - the retained copy's size and SHA-256 are recorded at registration and
 *     re-checked before it is served, from the SAME file descriptor the bytes
 *     are then streamed out of (`openStoredFile`). Verifying a path and then
 *     opening it again was a race: a replacement that landed between the two
 *     was served with the verified length;
 *   - what this does NOT defend against: the daemon (or root) rewriting the
 *     retained copy IN PLACE mid-stream. The spool is 0700 and the copy 0600, so
 *     that is not another process; a REPLACEMENT — a new file or a symlink at
 *     that path, which is what a path-based race is — is refused, and a stream
 *     already open keeps reading the inode that was verified;
 *   - when the copy cannot be made (no space, an unwritable spool) the record
 *     falls back to a checksummed REFERENCE, which is what the token had
 *     before: availability is kept and the fd-verified serve path still refuses
 *     anything but the exact registered bytes;
 *   - a path that could not be read at registration has no checksum and is
 *     never served.
 *
 * Retention is the token's: rows expire with the same TTL and the same bound on
 * how many are kept, the snapshot dies with the row, and so does the retained
 * copy — expiry, eviction and a spool file whose row is gone (a crash between
 * the copy and the insert) are all swept.
 */
import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";

/** Files up to this size are copied into the row; larger ones are retained as a private copy. */
export const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Directory name, next to the database, that holds the retained copies. */
export const RETAINED_ATTACHMENT_DIR = "web-attachment-blobs";

export interface StoredAttachment {
  readonly token: string;
  readonly name: string;
  readonly mimeType?: string;
  /**
   * A file too large to snapshot, by path. Normally the store's OWN immutable
   * copy (`retained`); a reference to the caller's real path only when the copy
   * could not be made. Servable only while `openStoredFile` still recognises the
   * bytes; a small attachment has `data` instead and no path at all.
   */
  readonly path?: string;
  /** True when `path` names the store's private copy, which it owns and deletes. */
  readonly retained?: boolean;
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

/** An open, verified handle on a retained file: the fd the bytes must be read from. */
export interface OpenStoredFile {
  readonly fd: number;
  readonly sizeBytes: number;
}

/** SHA-256 of a file, read in chunks so a huge file does not land in memory. */
function hashFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    return hashDescriptor(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * SHA-256 of whatever `fd` is open on, by POSITIONED reads: the descriptor's
 * own offset is left where it was, so the caller can stream the same fd from
 * byte 0 afterwards.
 */
function hashDescriptor(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = 0;
  for (;;) {
    const read = readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}

interface AttachmentSnapshot {
  path: string | null;
  retained: boolean;
  data: Buffer | null;
  sizeBytes: number | null;
  checksum: string | null;
}

export class WebAttachmentStore {
  private readonly db: Database.Database;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtDeleteExpired: Database.Statement;
  private readonly stmtSelectExpiredRetained: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtSelectOldest: Database.Statement;
  private readonly stmtDeleteByToken: Database.Statement;
  private readonly stmtRetainedTokens: Database.Statement;
  /** Where retained copies live. Created on first use, not at construction. */
  private readonly retainDir: string;
  private retainDirReady = false;

  constructor(
    dbPath: string = ":memory:",
    private readonly ttlMs: number = 24 * 60 * 60_000,
    private readonly maxEntries: number = 200,
    private readonly maxInlineBytes: number = DEFAULT_MAX_INLINE_ATTACHMENT_BYTES,
    retainDir?: string,
  ) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    // Next to the database, so a restart finds the copies its rows name. An
    // in-memory store has no restart to survive and gets a private temp dir.
    this.retainDir =
      retainDir ??
      (dbPath === ":memory:"
        ? join(mkdtempSync(join(tmpdir(), "strada-attachments-")), RETAINED_ATTACHMENT_DIR)
        : join(dirname(dbPath), RETAINED_ATTACHMENT_DIR));
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
        checksum TEXT,
        retained INTEGER NOT NULL DEFAULT 0
      )
    `);
    // A database written before round 9 #24 has neither checksum column; its
    // existing rows keep a path with no checksum, which is simply never served.
    // One written before round 10 #2 has no `retained` flag: its paths are the
    // caller's files, and a 0 there is exactly right — the store must never
    // delete a file it did not copy.
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(web_attachments)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!columns.has("byte_size")) this.db.exec("ALTER TABLE web_attachments ADD COLUMN byte_size INTEGER");
    if (!columns.has("checksum")) this.db.exec("ALTER TABLE web_attachments ADD COLUMN checksum TEXT");
    if (!columns.has("retained")) {
      this.db.exec("ALTER TABLE web_attachments ADD COLUMN retained INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_web_attachments_expiry ON web_attachments(expires_at)");

    this.stmtInsert = this.db.prepare(
      `INSERT INTO web_attachments (token, name, mime_type, path, data, chat_id, created_at, expires_at, byte_size, checksum, retained)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGet = this.db.prepare("SELECT * FROM web_attachments WHERE token = ?");
    this.stmtDeleteExpired = this.db.prepare("DELETE FROM web_attachments WHERE expires_at <= ?");
    this.stmtSelectExpiredRetained = this.db.prepare(
      "SELECT path FROM web_attachments WHERE expires_at <= ? AND retained = 1 AND path IS NOT NULL",
    );
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS n FROM web_attachments");
    this.stmtSelectOldest = this.db.prepare(
      "SELECT token, path, retained FROM web_attachments ORDER BY created_at ASC LIMIT ?",
    );
    this.stmtDeleteByToken = this.db.prepare("DELETE FROM web_attachments WHERE token = ?");
    this.stmtRetainedTokens = this.db.prepare(
      "SELECT token FROM web_attachments WHERE retained = 1 AND path IS NOT NULL",
    );
    this.sweepOrphanedCopies();
  }

  /**
   * Delete a retained copy. Only ever called for a path this store wrote (the
   * `retained` flag), never for a caller's own file.
   */
  private discardCopy(path: string | null | undefined): void {
    if (!path) return;
    try {
      rmSync(path, { force: true });
    } catch {
      // Already gone, or not ours to remove: the row is going away regardless.
    }
  }

  /**
   * Drop every expired row, and the copies they owned. Returns nothing: the
   * point is that a copy never outlives its token.
   */
  private purgeExpired(now: number): void {
    const doomed = this.stmtSelectExpiredRetained.all(now) as Array<{ path: string | null }>;
    this.stmtDeleteExpired.run(now);
    for (const row of doomed) this.discardCopy(row.path);
  }

  /** Drop the `count` oldest rows (the entry bound), and the copies they owned. */
  private purgeOldest(count: number): void {
    const doomed = this.stmtSelectOldest.all(count) as Array<{
      token: string;
      path: string | null;
      retained: number;
    }>;
    for (const row of doomed) {
      this.stmtDeleteByToken.run(row.token);
      if (row.retained === 1) this.discardCopy(row.path);
    }
  }

  /**
   * A copy whose row is gone is a leak: the process died between writing the
   * file and inserting the row, or an older build wrote it. Swept once, at
   * construction, bounded by what the directory holds.
   */
  private sweepOrphanedCopies(): void {
    try {
      if (!existsSync(this.retainDir)) return;
      const live = new Set(
        (this.stmtRetainedTokens.all() as Array<{ token: string }>).map((r) => r.token),
      );
      for (const name of readdirSync(this.retainDir)) {
        if (!live.has(name)) this.discardCopy(join(this.retainDir, name));
      }
    } catch {
      // A spool we cannot read is not a reason to refuse every attachment.
    }
  }

  /** The spool directory, created (0700) the first time a copy needs it. */
  private ensureRetainDir(): string {
    if (!this.retainDirReady) {
      mkdirSync(this.retainDir, { recursive: true, mode: 0o700 });
      this.retainDirReady = true;
    }
    return this.retainDir;
  }

  /**
   * What the token will own. Bytes are taken here, once, while the caller still
   * vouches for the file — never at serve time, when the path may name
   * something else entirely (round 9 #24). A file too large to inline is COPIED
   * (round 10 #2), so the token stops depending on a path anybody else can
   * delete or replace.
   */
  private snapshot(token: string, attachment: AttachmentToStore): AttachmentSnapshot {
    if (attachment.data) {
      return {
        path: null,
        retained: false,
        data: attachment.data,
        sizeBytes: attachment.data.length,
        checksum: createHash("sha256").update(attachment.data).digest("hex"),
      };
    }
    const source = attachment.path;
    if (!source) return { path: null, retained: false, data: null, sizeBytes: null, checksum: null };
    try {
      // Resolved ONCE, here: a symlink swapped in afterwards cannot redirect
      // an existing token.
      const real = realpathSync(source);
      const info = statSync(real);
      if (!info.isFile()) return { path: real, retained: false, data: null, sizeBytes: null, checksum: null };
      if (info.size <= this.maxInlineBytes) {
        const data = readFileSync(real);
        return {
          path: null,
          retained: false,
          data,
          sizeBytes: data.length,
          checksum: createHash("sha256").update(data).digest("hex"),
        };
      }
      // Too large for the row: retain a private copy instead, and describe THAT
      // copy. Measuring the copy (not the source) is what makes the recorded
      // size and checksum true for the whole life of the token.
      try {
        const copy = join(this.ensureRetainDir(), token);
        copyFileSync(real, copy);
        chmodSync(copy, 0o600);
        const copied = statSync(copy);
        return {
          path: copy,
          retained: true,
          data: null,
          sizeBytes: copied.size,
          checksum: hashFile(copy),
        };
      } catch {
        // No space, an unwritable spool, a source that vanished mid-copy: fall
        // back to the checksummed reference the token had before round 10 #2.
        // Availability is kept; the serve path still refuses anything but these
        // exact bytes.
        this.discardCopy(join(this.retainDir, token));
        return { path: real, retained: false, data: null, sizeBytes: info.size, checksum: hashFile(real) };
      }
    } catch {
      // Unreadable at registration: the path is kept so diagnostics can say
      // what was promised, and with no checksum it is never served.
      return { path: source, retained: false, data: null, sizeBytes: null, checksum: null };
    }
  }

  /** Register a file or bytes and return the token the link uses. */
  register(attachment: AttachmentToStore): string {
    const now = Date.now();
    this.purgeExpired(now);
    const count = (this.stmtCount.get() as { n: number }).n;
    const over = count - (this.maxEntries - 1);
    if (over > 0) this.purgeOldest(over);
    const token = randomBytes(18).toString("base64url");
    const snapshot = this.snapshot(token, attachment);
    this.stmtInsert.run(
      token, attachment.name, attachment.mimeType ?? null, snapshot.path,
      snapshot.data, attachment.chatId ?? null, now, now + this.ttlMs,
      snapshot.sizeBytes, snapshot.checksum, snapshot.retained ? 1 : 0,
    );
    return token;
  }

  /** The record behind a token, or null when it is unknown or expired. */
  get(token: string): StoredAttachment | null {
    const row = this.stmtGet.get(token) as
      | {
          token: string; name: string; mime_type: string | null; path: string | null; data: Buffer | null;
          chat_id: string | null; expires_at: number; byte_size: number | null; checksum: string | null;
          retained: number | null;
        }
      | undefined;
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.purgeExpired(Date.now());
      return null;
    }
    return {
      token: row.token,
      name: row.name,
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.path ? { path: row.path } : {}),
      ...(row.retained === 1 ? { retained: true } : {}),
      ...(row.data ? { data: row.data } : {}),
      ...(row.chat_id ? { chatId: row.chat_id } : {}),
      ...(row.byte_size === null ? {} : { sizeBytes: row.byte_size }),
      ...(row.checksum === null ? {} : { checksum: row.checksum }),
      expiresAt: row.expires_at,
    };
  }

  /**
   * Open a by-reference record's file and VERIFY it through the very descriptor
   * the caller will read: a regular file (O_NOFOLLOW refuses a symlink that
   * appeared later) of the recorded size with the recorded SHA-256. Returns the
   * open fd, or null — and never an fd that failed a check.
   *
   * Verifying a path and then opening it separately was round 10 #2's race: a
   * file replaced in between was streamed under the verified length. One inode,
   * checked and read, cannot be swapped: a replacement after this call changes
   * the directory entry, not the file this fd is open on.
   */
  openStoredFile(entry: StoredAttachment): OpenStoredFile | null {
    if (!entry.path || entry.checksum === undefined || entry.sizeBytes === undefined) return null;
    let fd: number | undefined;
    try {
      fd = openSync(entry.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size !== entry.sizeBytes) throw new Error("not the registered file");
      if (hashDescriptor(fd) !== entry.checksum) throw new Error("not the registered bytes");
      return { fd, sizeBytes: info.size };
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // nothing to release
        }
      }
      return null;
    }
  }

  /**
   * Whether the file behind a by-reference record is still EXACTLY what was
   * registered. A record with no checksum — one whose bytes were never captured,
   * including rows written before round 9 #24 — is never servable. Prefer
   * `openStoredFile` on the serve path: this answers about a path, and a path's
   * answer is stale the moment it is returned.
   */
  verifyStoredFile(entry: StoredAttachment): boolean {
    const open = this.openStoredFile(entry);
    if (!open) return false;
    try {
      closeSync(open.fd);
    } catch {
      // nothing to release
    }
    return true;
  }

  /** How many records are live (diagnostics / tests). */
  size(): number {
    this.purgeExpired(Date.now());
    return (this.stmtCount.get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
