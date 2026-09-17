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
 *
 * Round 11 #14 and #15 fixed WHEN and WHERE that sweeping happens:
 *
 *   - expiry used to run only inside `register`, `get` and `size`, so a daemon
 *     that sent one recording and went quiet kept the copy for ever, and a
 *     restart kept it too — the expired row was still in the retained-token
 *     inventory the startup sweep trusts, so the file looked live. Expiry now
 *     runs AT STARTUP and on an idle timer (`attachmentSweepIntervalMs`), so no
 *     call from anybody is needed for a copy to die with its token;
 *   - a store that made its OWN spool (an in-memory database has no restart to
 *     survive, so it gets a private temp directory) removes it on `close`;
 *   - the spool is NAMESPACED BY DATABASE (`attachmentSpoolDir`). It used to
 *     default to one directory per folder, so opening a second database next to
 *     the first swept the first's copies: their tokens are absent from the second
 *     database, which is precisely what "orphan" means;
 *   - a copy is written to `incoming/` and moved to its final, sweepable name
 *     only AFTER the row that claims it exists. A completed copy sitting at its
 *     final name with no row is indistinguishable from the leak a crash leaves,
 *     and another process opening in that window deleted a live attachment. Only
 *     age can tell a crash from a copy in progress, so a staged file is swept
 *     once it has been untouched for `PENDING_ATTACHMENT_GRACE_MS`.
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
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";

/** Files up to this size are copied into the row; larger ones are retained as a private copy. */
export const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Directory name, next to the database, that holds the retained copies. Every
 * database's spool is a subdirectory of this one (see `attachmentSpoolDir`), so
 * a caller that backs up or prunes the whole tree covers every store in that
 * directory; `attachmentSpoolRoot` builds the path.
 */
export const RETAINED_ATTACHMENT_DIR = "web-attachment-blobs";

/**
 * Subdirectory of a spool holding copies that have no row yet. Invisible to the
 * orphan sweep on purpose (round 11 #15): another process must not delete the
 * file this one is about to insert a row for.
 */
export const PENDING_ATTACHMENT_DIR = "incoming";

/**
 * A staged copy untouched for this long was left by a crash, not by a copy in
 * progress, and is swept. Nothing younger is: a 2 GB recording being copied and
 * hashed must survive another process's startup sweep.
 */
export const PENDING_ATTACHMENT_GRACE_MS = 60 * 60_000;

/** Floor and ceiling on the idle expiry sweep derived from the TTL. */
export const MIN_ATTACHMENT_SWEEP_MS = 25;
export const MAX_ATTACHMENT_SWEEP_MS = 5 * 60_000;

/**
 * How often an idle store purges expired rows and their copies. Derived from the
 * TTL rather than configured: a store nobody calls into must still let its
 * copies die (round 11 #14), and the caller that chose the TTL should not have
 * to ask for that separately.
 */
export function attachmentSweepIntervalMs(ttlMs: number): number {
  const half = Math.floor(ttlMs / 2);
  if (!Number.isFinite(half) || half < MIN_ATTACHMENT_SWEEP_MS) return MIN_ATTACHMENT_SWEEP_MS;
  return Math.min(half, MAX_ATTACHMENT_SWEEP_MS);
}

/**
 * The directory holding every attachment spool next to `dbPath`, or null for an
 * in-memory database, whose spool is a private temp directory that dies with the
 * store. This is the path to back up or prune: it covers all databases in that
 * directory.
 */
export function attachmentSpoolRoot(dbPath: string): string | null {
  if (dbPath === ":memory:") return null;
  return join(dirname(dbPath), RETAINED_ATTACHMENT_DIR);
}

/**
 * Where THIS database's retained copies live: a subdirectory of
 * `attachmentSpoolRoot` named after the database file. Null for an in-memory
 * database.
 *
 * Round 11 #15: every store used to default to the root itself, so a second
 * database in the same directory swept the first's copies — their tokens are not
 * in the second database, and that is exactly the test for an orphan. The name
 * is derived from the database's file name only, so it is stable across a
 * restart and across moving the directory.
 */
export function attachmentSpoolDir(dbPath: string): string | null {
  const root = attachmentSpoolRoot(dbPath);
  if (!root) return null;
  const name = basename(dbPath);
  // The readable half is for a human reading the directory; the digest is what
  // guarantees two databases never collide after sanitising.
  const readable = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "db";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return join(root, `${readable}-${digest}`);
}

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
  /**
   * The web profile identity this attachment was delivered to (plan 6.14).
   * Absent means "no identity this instance can name owns it" — a row written
   * before the column existed, or a chat with no identity at all. That absence
   * is UNATTRIBUTABLE, which the access model reads conservatively; it is not
   * "anyone may read it".
   */
  readonly ownerProfileId?: string;
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
  /** The identity the link is scoped to (plan 6.14). Omitted ⇒ unattributable. */
  readonly ownerProfileId?: string;
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
  /**
   * Where a retained copy is waiting while its row is written. `path` is the
   * name it takes once the row exists; until then nothing may sweep it.
   */
  staged?: string;
}

export class WebAttachmentStore {
  private readonly db: Database.Database;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtGetOwner: Database.Statement;
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtPutMeta: Database.Statement;
  private readonly stmtDeleteExpired: Database.Statement;
  private readonly stmtSelectExpiredRetained: Database.Statement;
  private readonly stmtCount: Database.Statement;
  private readonly stmtSelectOldest: Database.Statement;
  private readonly stmtDeleteByToken: Database.Statement;
  private readonly stmtRetainedTokens: Database.Statement;
  /** Where retained copies live. Created on first use, not at construction. */
  private readonly retainDir: string;
  private retainDirReady = false;
  /**
   * A temp spool this store created for itself, and therefore owns: removed on
   * `close`. Null for a spool next to a database or one the caller named —
   * those outlive the process on purpose.
   */
  private readonly ownedSpoolRoot: string | null;
  /** The idle expiry sweep (round 11 #14). Cleared by `close`. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private sweeps = 0;

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
    // Next to the database and NAMED AFTER IT (round 11 #15), so a restart
    // finds the copies its rows name and a different database in the same
    // directory never sees them as orphans. An in-memory store has no restart to
    // survive and gets a private temp dir, which it owns and removes on close.
    let owned: string | null = null;
    if (retainDir) {
      // The caller named the spool: theirs to place, theirs to share or not.
      this.retainDir = retainDir;
    } else if (dbPath === ":memory:") {
      owned = mkdtempSync(join(tmpdir(), "strada-attachments-"));
      this.retainDir = join(owned, RETAINED_ATTACHMENT_DIR);
    } else {
      this.retainDir = attachmentSpoolDir(dbPath)!;
    }
    this.ownedSpoolRoot = owned;
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
        retained INTEGER NOT NULL DEFAULT 0,
        owner_profile_id TEXT
      )
    `);
    // Plan 6.14: whose attachment this is, and the key that scopes its link —
    // both beside the rows, because the channel used to keep them in memory and
    // a restart therefore made every old link unattributable.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_attachment_meta (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        created_at INTEGER NOT NULL
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
    // One written before plan 6.14 has no owner column: its rows are
    // unattributable, which is the conservative direction — the access model
    // refuses them to a second identity rather than serving them to anyone.
    if (!columns.has("owner_profile_id")) {
      this.db.exec("ALTER TABLE web_attachments ADD COLUMN owner_profile_id TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_web_attachments_expiry ON web_attachments(expires_at)");

    this.stmtInsert = this.db.prepare(
      `INSERT INTO web_attachments (token, name, mime_type, path, data, chat_id, created_at, expires_at, byte_size, checksum, retained, owner_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGet = this.db.prepare("SELECT * FROM web_attachments WHERE token = ?");
    // Projected: the owner is asked for on every attachment GET and the row's
    // BLOB must not be read to answer it.
    this.stmtGetOwner = this.db.prepare(
      "SELECT owner_profile_id, expires_at FROM web_attachments WHERE token = ?",
    );
    this.stmtGetMeta = this.db.prepare("SELECT value FROM web_attachment_meta WHERE key = ?");
    this.stmtPutMeta = this.db.prepare(
      "INSERT INTO web_attachment_meta (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
    );
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
    // Expiry BEFORE the orphan sweep, and both at startup: an expired row used
    // to survive a restart because it was still in the retained-token inventory
    // the orphan sweep trusts, so its copy looked live (round 11 #14).
    this.purgeExpired(Date.now());
    this.sweepOrphanedCopies();
    this.sweepTimer = setInterval(() => this.sweepIdle(), attachmentSweepIntervalMs(this.ttlMs));
    // Retention must never be the reason the process stays alive.
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  /** Where this store keeps its retained copies (diagnostics, backup, tests). */
  get spoolDir(): string {
    return this.retainDir;
  }

  /**
   * Idle sweep TICKS (diagnostics / tests). Counts the timer firing, not the
   * work it did, so a test can see that `close` actually stopped the timer.
   */
  get idleSweeps(): number {
    return this.sweeps;
  }

  /**
   * The timer half of retention: nobody has to call in for a copy to die. Cheap
   * on purpose — an indexed delete, not a directory walk, which is why the
   * orphan sweep stays at construction.
   */
  private sweepIdle(): void {
    this.sweeps += 1;
    // The tick the event loop had already queued when `close` ran: the database
    // is gone, and purging it would throw inside a timer.
    if (this.closed) return;
    try {
      this.purgeExpired(Date.now());
    } catch {
      // A busy database is swept on the next tick; a failing sweep must not
      // become an uncaught exception in a timer.
    }
  }

  /**
   * Delete a retained copy. Only ever called for a path this store wrote (the
   * `retained` flag), never for a caller's own file.
   */
  private discardCopy(path: string | null | undefined): void {
    if (!path) return;
    try {
      // Never recursive: a sweep must not be able to take a DIRECTORY, which is
      // the second line of defence for the staging directory (round 11 #15).
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
   *
   * It judges by the absence of a row, so it may only look at names that HAVE a
   * row by now: the staging directory is skipped (round 11 #15) and aged out
   * separately.
   */
  private sweepOrphanedCopies(): void {
    try {
      if (!existsSync(this.retainDir)) return;
      const live = new Set(
        (this.stmtRetainedTokens.all() as Array<{ token: string }>).map((r) => r.token),
      );
      for (const name of readdirSync(this.retainDir)) {
        if (name === PENDING_ATTACHMENT_DIR) continue; // in flight: not ours to judge
        if (!live.has(name)) this.discardCopy(join(this.retainDir, name));
      }
    } catch {
      // A spool we cannot read is not a reason to refuse every attachment.
    }
    this.sweepStagedCopies();
  }

  /**
   * The staging directory cannot be swept by "has a row", because not having one
   * yet is the whole point of it. Only age separates a crash from a copy in
   * progress: `copyFileSync` keeps touching the file it is writing, so anything
   * untouched for `PENDING_ATTACHMENT_GRACE_MS` was abandoned.
   */
  private sweepStagedCopies(): void {
    const pending = join(this.retainDir, PENDING_ATTACHMENT_DIR);
    let names: string[];
    try {
      names = readdirSync(pending);
    } catch {
      return; // no staging directory yet, or one we cannot read
    }
    const abandoned = Date.now() - PENDING_ATTACHMENT_GRACE_MS;
    for (const name of names) {
      const staged = join(pending, name);
      try {
        if (statSync(staged).mtimeMs <= abandoned) this.discardCopy(staged);
      } catch {
        // Gone already, or unreadable: nothing to reclaim.
      }
    }
  }

  /**
   * The spool directory and its staging subdirectory, created (0700) the first
   * time a copy needs them.
   */
  private ensureRetainDir(): string {
    if (!this.retainDirReady) {
      mkdirSync(join(this.retainDir, PENDING_ATTACHMENT_DIR), { recursive: true, mode: 0o700 });
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
        const spool = this.ensureRetainDir();
        // Written under `incoming/`, and moved to the name the row will carry
        // only once that row exists (`register`). A finished copy at its final
        // name with no row is what a crash leaves behind, so another process
        // sweeping in that window deleted live attachments (round 11 #15).
        const staged = join(spool, PENDING_ATTACHMENT_DIR, token);
        copyFileSync(real, staged);
        chmodSync(staged, 0o600);
        const copied = statSync(staged);
        return {
          path: join(spool, token),
          retained: true,
          data: null,
          sizeBytes: copied.size,
          checksum: hashFile(staged),
          staged,
        };
      } catch {
        // No space, an unwritable spool, a source that vanished mid-copy: fall
        // back to the checksummed reference the token had before round 10 #2.
        // Availability is kept; the serve path still refuses anything but these
        // exact bytes.
        this.discardCopy(join(this.retainDir, PENDING_ATTACHMENT_DIR, token));
        return { path: real, retained: false, data: null, sizeBytes: info.size, checksum: hashFile(real) };
      }
    } catch {
      // Unreadable at registration: the path is kept so diagnostics can say
      // what was promised, and with no checksum it is never served.
      return { path: source, retained: false, data: null, sizeBytes: null, checksum: null };
    }
  }

  /**
   * The pre-round-10 form of a record: the caller's own file, checksummed. Used
   * when the private copy could not be made, or could not be published.
   */
  private referenceSnapshot(attachment: AttachmentToStore): AttachmentSnapshot {
    const source = attachment.path;
    if (!source) return { path: null, retained: false, data: null, sizeBytes: null, checksum: null };
    try {
      const real = realpathSync(source);
      const info = statSync(real);
      if (!info.isFile()) return { path: real, retained: false, data: null, sizeBytes: null, checksum: null };
      return { path: real, retained: false, data: null, sizeBytes: info.size, checksum: hashFile(real) };
    } catch {
      return { path: source, retained: false, data: null, sizeBytes: null, checksum: null };
    }
  }

  private insertRow(token: string, attachment: AttachmentToStore, snapshot: AttachmentSnapshot, now: number): void {
    this.stmtInsert.run(
      token, attachment.name, attachment.mimeType ?? null, snapshot.path,
      snapshot.data, attachment.chatId ?? null, now, now + this.ttlMs,
      snapshot.sizeBytes, snapshot.checksum, snapshot.retained ? 1 : 0,
      attachment.ownerProfileId ?? null,
    );
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
    // ROW FIRST, then the file at the name it promises: the row is what makes a
    // copy defensible against every sweep, so the copy must never be reachable
    // at that name before it (round 11 #15).
    this.insertRow(token, attachment, snapshot, now);
    if (snapshot.staged) {
      try {
        renameSync(snapshot.staged, snapshot.path!);
      } catch {
        // The row would promise a file that is not there. Take it back and keep
        // the attachment as the checksummed reference instead — the same
        // availability-over-immutability trade the copy failure makes.
        this.stmtDeleteByToken.run(token);
        this.discardCopy(snapshot.staged);
        this.insertRow(token, attachment, this.referenceSnapshot(attachment), now);
      }
    }
    return token;
  }

  /**
   * The identity an attachment link is scoped to (plan 6.14), or undefined when
   * the token is unknown, expired, or belongs to a row with no owner recorded —
   * one written before the column existed, or delivered to a chat with no
   * identity. Undefined means UNATTRIBUTABLE: the access model must refuse it to
   * a second identity, never read it as "anyone may".
   *
   * Asked on every attachment GET, so it reads two columns rather than the row
   * (a snapshot row carries up to 8 MiB of bytes).
   */
  ownerProfileIdOf(token: string): string | undefined {
    const row = this.stmtGetOwner.get(token) as
      | { owner_profile_id: string | null; expires_at: number }
      | undefined;
    if (!row || row.expires_at <= Date.now()) return undefined;
    return row.owner_profile_id ?? undefined;
  }

  /**
   * The key that scopes this store's attachment links (plan 6.14). A browser
   * cannot put a profile header on an `<img src>`, so the href handed to the
   * owning socket carries an HMAC of (token, owner) instead — and that proof has
   * to keep verifying after a restart, which a per-process key could not do.
   * Created once, per database, and kept beside the rows it authorizes: it
   * unlocks nothing the rows themselves do not already hold.
   */
  linkScopeKey(): Buffer {
    const existing = this.stmtGetMeta.get(WebAttachmentStore.LINK_KEY) as { value: Buffer } | undefined;
    if (existing?.value && existing.value.length >= 32) return existing.value;
    const fresh = randomBytes(32);
    this.stmtPutMeta.run(WebAttachmentStore.LINK_KEY, fresh, Date.now());
    const stored = this.stmtGetMeta.get(WebAttachmentStore.LINK_KEY) as { value: Buffer } | undefined;
    return stored?.value ?? fresh;
  }

  private static readonly LINK_KEY = "link_scope_key";

  /** The record behind a token, or null when it is unknown or expired. */
  get(token: string): StoredAttachment | null {
    const row = this.stmtGet.get(token) as
      | {
          token: string; name: string; mime_type: string | null; path: string | null; data: Buffer | null;
          chat_id: string | null; expires_at: number; byte_size: number | null; checksum: string | null;
          retained: number | null; owner_profile_id: string | null;
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
      ...(row.owner_profile_id ? { ownerProfileId: row.owner_profile_id } : {}),
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
    if (this.closed) return; // idempotent: a channel may stop twice
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.db.close();
    // A spool this store made FOR ITSELF dies with it: an in-memory database has
    // no restart to survive, so its copies have nothing left to serve and the
    // temp directory would be orphaned for the life of the machine (round 11
    // #14). A spool next to a database, or one the caller named, is left alone.
    if (this.ownedSpoolRoot) {
      try {
        rmSync(this.ownedSpoolRoot, { recursive: true, force: true });
      } catch {
        // Nothing we can do at shutdown; the directory is a temp one either way.
      }
    }
  }
}
