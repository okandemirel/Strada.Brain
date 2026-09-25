// ---------------------------------------------------------------------------
// HubOwnerStore — durable {chatId → channelType} for the HubChannel (plan 2.10,
// audit 12F2/D59).
//
// Which member a chat id belongs to used to live only in memory, so after a
// restart a daemon/goal notification for a persisted chat fell back to
// `claimsChatId` shape-guessing or the primary member.
//
// It then lived in a JSON file that every write re-read, merged and replaced by
// rename. That is a read-modify-write of the WHOLE map (Codex 2026-09-17 round
// 9 #31): two daemons that both read the file and then renamed their own
// snapshots still lost a binding, and `bind()` asserted its entire first-read
// map, so a stale unrelated binding overwrote a newer value written in between.
//
// Ownership is now ONE KEYED ROW PER CHAT in SQLite — the pattern
// `web-identity-store.ts` and `web-attachment-store.ts` already use — and
// `bind()` upserts only the row it changes. Nothing it was not asked to change
// is ever rewritten, so concurrent writers cannot erase each other and a stale
// view cannot resurrect an old owner. There is no whole-map write path left.
//
// The old `hub-owners.json` is imported once at construction (rows already in
// the database win: the file stopped being written when the database took
// over), then renamed to `hub-owners.json.migrated` — kept, not deleted, so an
// upgrade loses nobody's bindings and the previous state stays inspectable.
//
// Failures are logged, never thrown: a routing hint must not take the channel
// down. A store whose database cannot be opened degrades to a no-op (routing
// falls back to shape-guessing) instead of failing the hub's construction.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { configureSqlitePragmas } from "../../memory/unified/sqlite-pragmas.js";
import { resolveStradaHome } from "../../common/runtime-paths.js";
import { getLoggerSafe } from "../../utils/logger.js";

/** The SQLite file ownership lives in. */
export const HUB_OWNERS_DB_FILE = "hub-owners.db";
/** The pre-round-9 JSON file: imported once, then renamed aside. */
export const HUB_OWNERS_LEGACY_FILE = "hub-owners.json";
/** What the imported JSON file is renamed to (it is kept, never deleted). */
export const HUB_OWNERS_MIGRATED_SUFFIX = ".migrated";

interface LegacyOwnersFile {
  version?: number;
  owners?: Record<string, unknown>;
}

interface OwnerRow {
  chat_id: string;
  channel_type: string;
}

export class HubOwnerStore {
  private db: Database.Database | null = null;
  private stmtAll: Database.Statement | null = null;
  private stmtUpsert: Database.Statement | null = null;

  constructor(readonly dbPath: string) {
    this.open();
    this.importLegacyFile();
  }

  /** The default location: `<strada home>/hub-owners.db`. */
  static defaultPath(): string {
    return join(resolveStradaHome(), HUB_OWNERS_DB_FILE);
  }

  /** Every persisted binding. Empty (never throwing) when the database is unusable. */
  load(): Map<string, string> {
    const owners = new Map<string, string>();
    if (!this.stmtAll) return owners;
    try {
      for (const row of this.stmtAll.all() as OwnerRow[]) {
        if (row.chat_id && row.channel_type) owners.set(row.chat_id, row.channel_type);
      }
    } catch (err) {
      getLoggerSafe().warn("Hub owner store unreadable — starting without persisted ownership", {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return owners;
  }

  /**
   * Every persisted binding with when it was last written, oldest first, so a
   * caller that keeps them in insertion order gets least-recently-used first.
   * Empty (never throwing) when the database is unusable.
   */
  loadEntries(): Array<{ chatId: string; channelType: string; updatedAt: number }> {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare("SELECT chat_id, channel_type, updated_at FROM hub_owners ORDER BY updated_at ASC, rowid ASC")
        .all() as Array<OwnerRow & { updated_at: number }>;
      return rows
        .filter((row) => row.chat_id && row.channel_type)
        .map((row) => ({ chatId: row.chat_id, channelType: row.channel_type, updatedAt: row.updated_at }));
    } catch (err) {
      getLoggerSafe().warn("Hub owner store unreadable — starting without persisted ownership", {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * CHN-19: ownership rows are routing hints, not authority, and there used to
   * be one per chat id forever (a web chat id is a new UUID per connection
   * unless reclaimed). Drops rows not written since `olderThan`, then all but
   * the `keepNewest` most recently written. Returns how many went.
   */
  prune(olderThan: number, keepNewest: number): number {
    if (!this.db) return 0;
    try {
      const db = this.db;
      return db.transaction(() =>
        db.prepare("DELETE FROM hub_owners WHERE updated_at < ?").run(olderThan).changes
        + db.prepare(
          `DELETE FROM hub_owners WHERE chat_id NOT IN (
             SELECT chat_id FROM hub_owners ORDER BY updated_at DESC, rowid DESC LIMIT ?
           )`,
        ).run(keepNewest).changes,
      )();
    } catch (err) {
      getLoggerSafe().warn("Hub owner store prune failed", {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /**
   * Record ONE binding as a keyed upsert. This is the only write path: no other
   * chat's row is read, merged or rewritten, so a concurrent writer's binding
   * survives and a stale in-memory view cannot undo a newer rebind (#31).
   */
  bind(chatId: string, memberName: string): void {
    if (!chatId || !memberName) return;
    if (!this.stmtUpsert) return; // open() already warned
    try {
      this.stmtUpsert.run(chatId, memberName, Date.now());
    } catch (err) {
      getLoggerSafe().warn("Hub owner store write failed — ownership will not survive a restart", {
        path: this.dbPath,
        chatId,
        channelType: memberName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Release the database handle. Safe to call twice. */
  close(): void {
    try {
      this.db?.close();
    } catch {
      // Already closed, or never opened: nothing to release.
    }
    this.db = null;
    this.stmtAll = null;
    this.stmtUpsert = null;
  }

  // ---- internals -----------------------------------------------------------

  private open(): void {
    try {
      if (this.dbPath !== ":memory:") {
        const dir = dirname(this.dbPath);
        if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
      const db = new Database(this.dbPath);
      configureSqlitePragmas(db, "identity");
      db.exec(`
        CREATE TABLE IF NOT EXISTS hub_owners (
          chat_id TEXT PRIMARY KEY,
          channel_type TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.stmtAll = db.prepare("SELECT chat_id, channel_type FROM hub_owners");
      this.stmtUpsert = db.prepare(
        `INSERT INTO hub_owners (chat_id, channel_type, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           channel_type = excluded.channel_type,
           updated_at = excluded.updated_at`,
      );
      this.db = db;
    } catch (err) {
      this.close();
      getLoggerSafe().warn("Hub owner store unavailable — ownership will not survive a restart", {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Import `hub-owners.json` once, then rename it to `<file>.migrated`. Rows
   * already in the database are NEWER than the file (it stopped being written
   * when the database took over), so a conflict keeps the row.
   */
  private importLegacyFile(): void {
    if (!this.db || this.dbPath === ":memory:") return;
    const legacyPath = join(dirname(this.dbPath), HUB_OWNERS_LEGACY_FILE);
    let raw: string;
    try {
      raw = readFileSync(legacyPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        getLoggerSafe().warn("Hub owner store legacy file unreadable — leaving it in place", {
          path: legacyPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const entries: Array<[string, string]> = [];
    try {
      const parsed = JSON.parse(raw) as LegacyOwnersFile | null;
      const owners = parsed && typeof parsed === "object" && parsed.owners && typeof parsed.owners === "object" ? parsed.owners : {};
      for (const [chatId, channelType] of Object.entries(owners)) {
        if (chatId && typeof channelType === "string" && channelType) entries.push([chatId, channelType]);
      }
    } catch (err) {
      getLoggerSafe().warn("Hub owner store legacy file corrupt — leaving it in place, starting from the database", {
        path: legacyPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const migratedPath = `${legacyPath}${HUB_OWNERS_MIGRATED_SUFFIX}`;
    try {
      const insert = this.db.prepare(
        `INSERT INTO hub_owners (chat_id, channel_type, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO NOTHING`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const [chatId, channelType] of entries) insert.run(chatId, channelType, now);
      })();
      renameSync(legacyPath, migratedPath);
      getLoggerSafe().info("Hub ownership migrated out of the legacy JSON file", {
        from: legacyPath,
        keptAs: migratedPath,
        db: this.dbPath,
        bindings: entries.length,
      });
    } catch (err) {
      getLoggerSafe().warn("Hub owner store legacy migration failed — leaving the JSON file in place", {
        path: legacyPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
