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

    this.stmtGet = this.db.prepare(
      "SELECT token_hash FROM web_identities WHERE profile_id = ?",
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
    return { profileId, profileToken };
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
