import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";

export interface WebIdentity {
  profileId: string;
  profileToken: string;
}

export class WebIdentityStore {
  private db: Database.Database | null = null;
  private stmtGet!: Database.Statement;
  private stmtSet!: Database.Statement;
  private stmtCount!: Database.Statement;
  private stmtGetMeta!: Database.Statement;
  private stmtClaimOwner!: Database.Statement;

  /** The meta key holding the instance owner's profile id (plan 6.14). */
  private static readonly OWNER_KEY = "owner_profile_id";

  constructor(private readonly dbPath: string = ":memory:") {
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

    this.stmtGet = this.db.prepare(
      "SELECT token_hash FROM web_identities WHERE profile_id = ?",
    );
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
      `INSERT INTO web_identities (profile_id, token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         updated_at = excluded.updated_at`,
    );
  }

  issue(preferredProfileId?: string): WebIdentity {
    const profileId = preferredProfileId?.trim() || randomUUID();
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
   * (`<memory.dbPath>/web-identities.db`), so an operator who loses the
   * browser's localStorage comes back as a GUEST — that is inherent to "the
   * first identity owns the instance" and not a bug. Recovery is to delete the
   * `owner_profile_id` row (or the database file) while the daemon is stopped;
   * the next identity issued claims the instance again.
   */
  claimOwner(profileId: string): string | undefined {
    const normalized = profileId.trim();
    if (!normalized) {
      return this.ownerProfileId();
    }
    this.stmtClaimOwner.run(WebIdentityStore.OWNER_KEY, normalized, Date.now());
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

  /** How many identities this instance has ever issued — >1 means it is genuinely shared. */
  count(): number {
    const row = this.stmtCount.get() as { n: number } | undefined;
    return row?.n ?? 0;
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
    return this.stmtGet.get(normalized) !== undefined;
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
