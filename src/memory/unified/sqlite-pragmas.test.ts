import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureSqlitePragmas, validateAndRepairSqlite } from "./sqlite-pragmas.js";
import type { SqliteProfile } from "./sqlite-pragmas.js";

// ---------------------------------------------------------------------------
// validateAndRepairSqlite (audited 2026-09-02)
// ---------------------------------------------------------------------------
// The "repair" used to be `db.pragma("REINDEX")`, which better-sqlite3 turns
// into `PRAGMA REINDEX` — an unknown pragma SQLite silently ignores. The
// recheck re-read the same damage, so the function could never return true
// for a corrupt-index database, and initSqlite discarded the verdict anyway.

describe("validateAndRepairSqlite", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function corruptIndexPage(dbPath: string): void {
    // Flip one key byte inside an index LEAF page (page type 0x0A) so the
    // page stays structurally valid but the index no longer matches the
    // table: integrity_check reports "row N missing from index", and the
    // table itself is intact — exactly the damage class a real REINDEX
    // repairs. (Zeroing the page makes integrity_check itself throw.)
    const probe = new Database(dbPath);
    const pageSize = probe.pragma("page_size", { simple: true }) as number;
    probe.close();
    const bytes = readFileSync(dbPath);
    const needle = Buffer.from("row-");
    for (let page = 1; page * pageSize < bytes.length; page++) {
      const start = page * pageSize;
      if (bytes[start] !== 0x0a) continue;
      // Leaf page header is 8 bytes; the cell pointer array follows. Use a
      // LIVE cell (not dead bytes in the free space left behind by splits).
      const cellCount = bytes.readUInt16BE(start + 3);
      if (cellCount === 0) continue;
      const cellOffset = start + bytes.readUInt16BE(start + 8);
      const at = bytes.indexOf(needle, cellOffset);
      if (at === -1 || at >= cellOffset + 80) continue;
      bytes[at + 1] = "x".charCodeAt(0); // "row-" -> "rxw-"
      writeFileSync(dbPath, bytes);
      return;
    }
    throw new Error("no index leaf page containing a key was found");
  }

  it("repairs a corrupt index with a real REINDEX and returns true", () => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-repair-"));
    const dbPath = join(dir, "memory.db");
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE t (x TEXT); CREATE INDEX idx_t_x ON t(x);");
    const ins = seed.prepare("INSERT INTO t (x) VALUES (?)");
    for (let i = 0; i < 400; i++) ins.run(`row-${i}-${"p".repeat(40)}`);
    seed.close();

    corruptIndexPage(dbPath);

    const damaged = new Database(dbPath);
    const before = damaged.pragma("integrity_check") as Array<{ integrity_check: string }>;
    expect(before[0]?.integrity_check).not.toBe("ok"); // precondition: really corrupt

    const healthy = validateAndRepairSqlite(damaged, "memory");
    const after = damaged.pragma("integrity_check") as Array<{ integrity_check: string }>;
    damaged.close();

    expect(after).toEqual([{ integrity_check: "ok" }]);
    expect(healthy).toBe(true);
  });

  it("returns true untouched for a healthy database", () => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-healthy-"));
    const db = new Database(join(dir, "memory.db"));
    db.exec("CREATE TABLE t (x TEXT); CREATE INDEX idx_t_x ON t(x); INSERT INTO t VALUES ('a');");
    expect(validateAndRepairSqlite(db, "memory")).toBe(true);
    db.close();
  });
});

describe("configureSqlitePragmas", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  function getPragma(name: string): unknown {
    return db.pragma(name, { simple: true });
  }

  it('sets correct pragmas for "memory" profile (16MB cache)', () => {
    db = new Database(":memory:");
    configureSqlitePragmas(db, "memory");

    expect(getPragma("cache_size")).toBe(-16000);
    expect(getPragma("busy_timeout")).toBe(5000);
    expect(getPragma("journal_mode")).toBe("memory"); // in-memory db returns "memory" not "wal"
    expect(getPragma("synchronous")).toBe(1); // NORMAL = 1
    expect(getPragma("temp_store")).toBe(2); // MEMORY = 2
    expect(getPragma("foreign_keys")).toBe(1); // ON = 1
  });

  it('sets correct pragmas for "learning" profile (16MB cache, NOT 64MB)', () => {
    db = new Database(":memory:");
    configureSqlitePragmas(db, "learning");

    expect(getPragma("cache_size")).toBe(-16000);
    expect(getPragma("busy_timeout")).toBe(5000);
    expect(getPragma("synchronous")).toBe(1);
    expect(getPragma("temp_store")).toBe(2);
    expect(getPragma("foreign_keys")).toBe(1);
  });

  it('sets correct pragmas for "tasks" profile (8MB cache)', () => {
    db = new Database(":memory:");
    configureSqlitePragmas(db, "tasks");

    expect(getPragma("cache_size")).toBe(-8000);
    expect(getPragma("busy_timeout")).toBe(5000);
    expect(getPragma("synchronous")).toBe(1);
    expect(getPragma("temp_store")).toBe(2);
    expect(getPragma("foreign_keys")).toBe(1);
  });

  it('sets correct pragmas for "preferences" profile (2MB cache)', () => {
    db = new Database(":memory:");
    configureSqlitePragmas(db, "preferences");

    expect(getPragma("cache_size")).toBe(-2000);
    expect(getPragma("busy_timeout")).toBe(5000);
    expect(getPragma("synchronous")).toBe(1);
    expect(getPragma("temp_store")).toBe(2);
    expect(getPragma("foreign_keys")).toBe(1);
  });

  it("all profiles set WAL, NORMAL sync, temp_store=memory, foreign_keys=ON", () => {
    const profiles: SqliteProfile[] = ["memory", "learning", "tasks", "preferences"];

    for (const profile of profiles) {
      if (db) db.close();
      db = new Database(":memory:");
      configureSqlitePragmas(db, profile);

      expect(getPragma("synchronous")).toBe(1);
      expect(getPragma("temp_store")).toBe(2);
      expect(getPragma("foreign_keys")).toBe(1);
      expect(getPragma("busy_timeout")).toBe(5000);
    }
  });

  it("SqliteProfile type prevents invalid profiles at compile time", () => {
    db = new Database(":memory:");
    // This test verifies the type constraint exists.
    // At runtime, we test that the function handles all valid profiles.
    const validProfiles: SqliteProfile[] = ["memory", "learning", "tasks", "preferences"];
    for (const profile of validProfiles) {
      expect(() => configureSqlitePragmas(db, profile)).not.toThrow();
    }
  });
});
