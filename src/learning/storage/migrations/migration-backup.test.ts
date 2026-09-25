/**
 * LRN-20: the pre-migration backup copied the database file with the
 * connection open. In WAL mode recent commits live in the -wal file until a
 * checkpoint, so the copy could be missing them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MigrationRunner } from "./index.ts";

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migration-backup-"));
  dbPath = join(dir, "learning.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0"); // keep the commit below in the -wal file
  db.exec("CREATE TABLE instincts (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO instincts (id) VALUES (?)").run("committed-before-migration");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the pre-migration backup (LRN-20)", () => {
  it("holds every committed row, including those not yet checkpointed", () => {
    new MigrationRunner(db, dbPath).run([{ name: "999-test", up: (d) => d.exec("CREATE TABLE extra (x INTEGER)") }]);

    const backups = readdirSync(dir).filter((f) => f.startsWith("learning.db.bak-"));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dir, backups[0]!), { readonly: true });
    try {
      const rows = backup.prepare("SELECT id FROM instincts").all();
      expect(rows).toEqual([{ id: "committed-before-migration" }]);
    } finally {
      backup.close();
    }
  });
});
