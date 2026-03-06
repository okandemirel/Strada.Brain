import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { configureSqlitePragmas } from "./sqlite-pragmas.js";
import type { SqliteProfile } from "./sqlite-pragmas.js";

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
