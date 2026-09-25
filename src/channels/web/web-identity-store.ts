import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";
import { getLoggerSafe } from "../../utils/logger.js";

export interface WebIdentity {
  profileId: string;
  profileToken: string;
}

/**
 * CHN-19: an identity that never sent a message and has not been presented for
 * this long is abandoned (a private window, cleared storage, a script looping
 * sockets) and is pruned at boot.
 */
export const ABANDONED_IDENTITY_MS = 30 * 24 * 60 * 60 * 1000;

export class WebIdentityStore {
  private db: Database.Database | null = null;
  private stmtGet!: Database.Statement;
  private stmtSet!: Database.Statement;
  private stmtCount!: Database.Statement;
  private stmtGetMeta!: Database.Statement;
  private stmtClaimOwner!: Database.Statement;
  private stmtTombstoned!: Database.Statement;
  private stmtCountTombstones!: Database.Statement;
  private stmtMarkMessaged!: Database.Statement;
  private stmtMarkSeen!: Database.Statement;
  /** Profiles already known to have sent a message, so the hot path skips the write. */
  private readonly messagedProfiles = new Set<string>();

  /** The meta key holding the instance owner's profile id (plan 6.14). */
  private static readonly OWNER_KEY = "owner_profile_id";

  constructor(
    private readonly dbPath: string = ":memory:",
    private readonly abandonedAfterMs: number = ABANDONED_IDENTITY_MS,
  ) {
    this.initialize();
  }

  private initialize(): void {
    if (this.dbPath !== ":memory:") {
      const dir = dirname(this.dbPath);
      if (dir && dir !== "." && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.dbPath);
    configureSqlitePragmas(this.db, "identity");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_identities (
        profile_id TEXT PRIMARY KEY,
        token_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Plan 6.14: one daemon, more than one person. The instance needs a stated
    // owner — the identity allowed to write setup and control the daemon — and
    // it must survive a restart, so it lives next to the identities themselves.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_instance_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // CHN-19: activity, for pruning abandoned identities. Rows that predate
    // these columns take the defaults: `messaged` 1, i.e. never pruned, because
    // nobody can say what they did.
    for (const column of ["messaged INTEGER NOT NULL DEFAULT 1", "last_seen_at INTEGER"]) {
      try {
        this.db.exec(`ALTER TABLE web_identities ADD COLUMN ${column}`);
      } catch {
        // Column already exists.
      }
    }
    // A pruned identity leaves a tombstone: it was ISSUED, and stays so for
    // every visibility and ownership check (has(), count()), while no token
    // verifies for it and the legacy path can never register it again.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_identity_tombstones (
        profile_id TEXT PRIMARY KEY,
        pruned_at INTEGER NOT NULL
      )
    `);

    this.stmtGet = this.db.prepare(
      "SELECT token_hash FROM web_identities WHERE profile_id = ?",
    );
    this.stmtTombstoned = this.db.prepare("SELECT 1 FROM web_identity_tombstones WHERE profile_id = ?");
    this.stmtCountTombstones = this.db.prepare("SELECT COUNT(*) AS n FROM web_identity_tombstones");
    this.stmtMarkMessaged = this.db.prepare(
      "UPDATE web_identities SET messaged = 1 WHERE profile_id = ? AND messaged = 0",
    );
    this.stmtMarkSeen = this.db.prepare("UPDATE web_identities SET last_seen_at = ? WHERE profile_id = ?");
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS n FROM web_identities");
    this.stmtGetMeta = this.db.prepare("SELECT value FROM web_instance_meta WHERE key = ?");
    // DO NOTHING on conflict: ownership is claimed ONCE, by the first identity.
    // A later claim (a second browser, a guest replaying an old setup link)
    // must not be able to promote itself.
    this.stmtClaimOwner = this.db.prepare(
      `INSERT INTO web_instance_meta (key, value, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    );
    this.stmtSet = this.db.prepare(
      `INSERT INTO web_identities (profile_id, token_hash, created_at, updated_at, messaged)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(profile_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         updated_at = excluded.updated_at`,
    );

    this.adoptEstablishedOwner();
    this.pruneAbandoned();
  }

  /**
   * CHN-19: every portal socket without a valid pair minted an identity that
   * was kept forever. At boot, an identity that never sent a message and has
   * not been presented for `abandonedAfterMs` is pruned: its row (and token)
   * goes, a tombstone stays. It never sent a message, so it owns no task,
   * board or delivered attachment; and because the tombstone keeps it
   * "issued", anything it might own stays as private as before. The owner is
   * never pruned. Returns how many were pruned.
   */
  pruneAbandoned(now: number = Date.now()): number {
    const db = this.db!;
    const cutoff = now - this.abandonedAfterMs;
    const owner = this.ownerProfileId() ?? "";
    try {
      return db.transaction(() => {
        const stale = db.prepare(
          `SELECT profile_id FROM web_identities
           WHERE messaged = 0 AND COALESCE(last_seen_at, updated_at) < ? AND profile_id != ?`,
        ).all(cutoff, owner) as Array<{ profile_id: string }>;
        const bury = db.prepare("INSERT OR IGNORE INTO web_identity_tombstones (profile_id, pruned_at) VALUES (?, ?)");
        const remove = db.prepare("DELETE FROM web_identities WHERE profile_id = ?");
        for (const { profile_id } of stale) {
          bury.run(profile_id, now);
          remove.run(profile_id);
        }
        if (stale.length > 0) {
          getLoggerSafe().info("[WebIdentityStore] pruned abandoned identities", { count: stale.length });
        }
        return stale.length;
      })();
    } catch (err) {
      getLoggerSafe().warn("[WebIdentityStore] pruning abandoned identities failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /** Record that `profileId` sent a message: it is no longer prunable (CHN-19). */
  markMessaged(profileId: string): void {
    const normalized = profileId.trim();
    if (!normalized || this.messagedProfiles.has(normalized)) return;
    this.stmtMarkMessaged.run(normalized);
    this.messagedProfiles.add(normalized);
  }

  /** Record that `profileId` was presented and verified now (CHN-19). */
  markSeen(profileId: string, now: number = Date.now()): void {
    const normalized = profileId.trim();
    if (normalized) this.stmtMarkSeen.run(now, normalized);
  }

  /**
   * ROUND 13 #8: an UPGRADED instance keeps its owner.
   *
   * `web_instance_meta` arrived with plan 6.14, so every instance that served a
   * portal before it has a populated `web_identities` table and no owner row —
   * and `CREATE TABLE IF NOT EXISTS` above happily leaves that seat empty.
   * Nothing else filled it: a browser that already holds an identity reconnects
   * and verifies, it does not re-`issue()`, so the first claim came from the next
   * identity this instance ever issued. The next NEWCOMER inherited somebody
   * else's instance — its settings, its `.env`, its daemon — and the operator who
   * actually set it up was demoted to guest.
   *
   * The seat therefore goes to the identity that has held it all along: the
   * FIRST one this instance issued, which is precisely what `issue()` would have
   * recorded had the table existed then. Ordering is by `created_at`, then by
   * insertion order for identities minted inside the same millisecond.
   *
   * A database with no identities is left alone: there is nobody to adopt, and
   * the first `issue()` claims it as before.
   */
  private adoptEstablishedOwner(): void {
    if (this.ownerProfileId() !== undefined) return;
    const row = this.db!
      .prepare("SELECT profile_id FROM web_identities ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .get() as { profile_id: string } | undefined;
    if (!row?.profile_id) return;
    this.stmtClaimOwner.run(WebIdentityStore.OWNER_KEY, row.profile_id, Date.now());
  }

  issue(preferredProfileId?: string): WebIdentity {
    const preferred = preferredProfileId?.trim();
    // A pruned id is never handed out again (CHN-19).
    const profileId = preferred && this.stmtTombstoned.get(preferred) === undefined ? preferred : randomUUID();
    const profileToken = randomBytes(32).toString("base64url");
    const now = Date.now();

    this.stmtSet.run(profileId, this.hashToken(profileToken), now, now);
    // The FIRST identity this instance ever issues is the instance owner: the
    // person who opened the portal and completed setup. Every later identity is
    // a guest (plan 6.14). Claiming here — rather than on a setup callback —
    // means the owner is recorded even when setup was completed on the CLI.
    this.claimOwner(profileId);
    return { profileId, profileToken };
  }

  /**
   * Record `profileId` as the instance owner if — and only if — no owner has
   * been recorded yet. Returns the owner in force afterwards, which is NOT
   * necessarily the argument.
   *
   * OPERATIONAL NOTE: the owner is sticky and lives in this database
   * (`<memory.dbPath>/web-identities.db`), so an operator who loses the browser's
   * localStorage comes back as a GUEST — inherent to "the first identity owns the
   * instance", not a bug. {@link reassignOwner} is the way back; deleting the
   * `owner_profile_id` row is NOT (round 14 #7: adoption puts the unreachable
   * identity straight back).
   */
  claimOwner(profileId: string): string | undefined {
    const normalized = profileId.trim();
    if (!normalized) {
      return this.ownerProfileId();
    }
    this.stmtClaimOwner.run(WebIdentityStore.OWNER_KEY, normalized, Date.now());
    return this.ownerProfileId();
  }

  /**
   * THE OWNER RECOVERY, AND WHY IT IS A HANDOVER RATHER THAN A DELETION
   * (round 14 #7).
   *
   * The old advice on `claimOwner` was "delete the \`owner_profile_id\` row and
   * restart; the next identity issued claims the instance". That stopped being
   * true the moment `initialize()` learned to adopt the oldest ESTABLISHED
   * identity (round 13 #8, which exists so that upgrading an instance does not
   * hand it to the next newcomer): after the deletion, adoption restores the very
   * identity whose browser storage was lost, and the replacement browser stays a
   * guest forever. A written-down procedure that a later fix disabled is worse
   * than none.
   *
   * So ownership is handed over explicitly, to an identity this instance has
   * actually issued:
   *
   *   1. open the portal in the replacement browser and let it connect once —
   *      it is issued an identity (a guest) and stores it as `strada-profileId`
   *      in that browser's localStorage;
   *   2. stop the daemon (this database must not be open twice for a write);
   *   3. run the handover, either through this method or with the SQL it performs:
   *        UPDATE web_instance_meta SET value = '<the new profile id>'
   *         WHERE key = 'owner_profile_id';
   *   4. start the daemon. The replacement browser is the owner; the lost
   *      identity becomes an ordinary guest, and its own chats and attachments
   *      stay its own.
   *
   * Deleting the whole database file also works and is the nuclear option: every
   * identity is revoked, every browser gets a fresh one, and the first to connect
   * owns the instance again.
   *
   * Refuses — and leaves the owner untouched — for an identity this instance
   * never issued, so a typo in step 3 cannot leave the instance with an owner
   * nobody can present and every owner-only power permanently refused.
   */
  reassignOwner(profileId: string): string | undefined {
    const normalized = profileId.trim();
    // A LIVE identity: a pruned one is issued but can never present a token.
    if (!normalized || this.stmtGet.get(normalized) === undefined) {
      getLoggerSafe().warn("[WebIdentityStore] owner reassignment refused: not an identity this instance issued", {
        profileId: normalized || null,
      });
      return this.ownerProfileId();
    }
    this.db!
      .prepare(
        `INSERT INTO web_instance_meta (key, value, created_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(WebIdentityStore.OWNER_KEY, normalized, Date.now());
    getLoggerSafe().warn("[WebIdentityStore] the instance owner was reassigned", { ownerProfileId: normalized });
    return this.ownerProfileId();
  }

  /** The instance owner's profile id, or undefined on an instance that has issued none. */
  ownerProfileId(): string | undefined {
    const row = this.stmtGetMeta.get(WebIdentityStore.OWNER_KEY) as { value: string } | undefined;
    return row?.value;
  }

  /** True when `profileId` is the instance owner. An empty/unknown id never is. */
  isOwner(profileId: string | undefined): boolean {
    const owner = this.ownerProfileId();
    return owner !== undefined && profileId !== undefined && profileId.trim() === owner;
  }

  /**
   * How many identities this instance has ever issued — >1 means it is
   * genuinely shared. Pruned identities still count (CHN-19): pruning must never
   * turn a shared instance back into a single-identity one, which would widen
   * what an unattributed request may see.
   */
  count(): number {
    const live = this.stmtCount.get() as { n: number } | undefined;
    const pruned = this.stmtCountTombstones.get() as { n: number } | undefined;
    return (live?.n ?? 0) + (pruned?.n ?? 0);
  }

  /**
   * True if a profile is already registered (has a token). Used to refuse
   * re-minting a token for an already-claimed profileId from an unauthenticated
   * request (which the blind upsert in issue() would otherwise allow).
   */
  has(profileId: string): boolean {
    const normalized = profileId.trim();
    if (!normalized) {
      return false;
    }
    // A pruned identity was issued (CHN-19): its boards and attachments stay
    // private, and the legacy path must not register its id to someone else.
    return this.stmtGet.get(normalized) !== undefined || this.stmtTombstoned.get(normalized) !== undefined;
  }

  verify(profileId: string, profileToken: string): boolean {
    const normalizedProfileId = profileId.trim();
    const normalizedProfileToken = profileToken.trim();
    if (!normalizedProfileId || !normalizedProfileToken) {
      return false;
    }

    const row = this.stmtGet.get(normalizedProfileId) as { token_hash: Buffer } | undefined;
    if (!row) {
      return false;
    }

    const expected = row.token_hash;
    const actual = this.hashToken(normalizedProfileToken);
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private hashToken(token: string): Buffer {
    return createHash("sha256").update(token, "utf8").digest();
  }
}
