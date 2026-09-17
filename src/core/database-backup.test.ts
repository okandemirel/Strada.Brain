/**
 * Database backup and restore (14F3 / D72).
 *
 * The three defects, each with a test that fails when it comes back:
 *   1. only learning.db was backed up  -> listRuntimeDatabases covers the table
 *      AND whatever the memory root actually holds;
 *   2. `cp` while writes are in flight -> the control test below copies a live
 *      WAL database with cp and shows the copy missing committed rows, while
 *      db.backup() restores every one of them;
 *   3. the memory root was hardcoded   -> backup.sh honours MEMORY_DB_PATH.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_DATABASE_FILES,
  backupRuntimeDatabases,
  backupSqliteDatabase,
  listRuntimeDatabases,
  parseBackupArgs,
  runBackupCli,
} from "./database-backup.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let root: string;
let memoryRoot: string;
let destDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "strada-db-backup-"));
  memoryRoot = path.join(root, "memory");
  destDir = path.join(root, "backup");
  mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A WAL database with `rows` committed rows in table `t`. */
function seedDatabase(file: string, rows: number): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, payload TEXT)");
  const insert = db.prepare("INSERT INTO t (payload) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`row-${i}`);
  return db;
}

function countRows(file: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("listRuntimeDatabases", () => {
  it("covers every database the runtime keeps, not just learning.db", () => {
    for (const name of ["learning.db", "campaigns.db", "goals.db", "memory.db", "tasks.db"]) {
      seedDatabase(path.join(memoryRoot, name), 1).close();
    }
    const listed = listRuntimeDatabases(memoryRoot).map((p) => path.basename(p));
    expect(listed).toEqual(
      expect.arrayContaining(["learning.db", "campaigns.db", "goals.db", "memory.db", "tasks.db"]),
    );
    expect(listed).toHaveLength(5);
  });

  it("includes a database the table has not caught up with yet", () => {
    seedDatabase(path.join(memoryRoot, "learning.db"), 1).close();
    seedDatabase(path.join(memoryRoot, "invented-tomorrow.db"), 1).close();
    expect(RUNTIME_DATABASE_FILES).not.toContain("invented-tomorrow.db");
    expect(listRuntimeDatabases(memoryRoot).map((p) => path.basename(p))).toContain(
      "invented-tomorrow.db",
    );
  });

  it("never lists -wal/-shm sidecars or a missing file", () => {
    const db = seedDatabase(path.join(memoryRoot, "learning.db"), 5);
    writeFileSync(path.join(memoryRoot, "notes.txt"), "not a database");
    const listed = listRuntimeDatabases(memoryRoot).map((p) => path.basename(p));
    db.close();
    expect(listed).toEqual(["learning.db"]);
  });

  it("returns nothing for a memory root that does not exist yet", () => {
    expect(listRuntimeDatabases(path.join(root, "nope"))).toEqual([]);
  });
});

describe("backupSqliteDatabase", () => {
  it("restores cleanly from a backup taken while a write was in flight", async () => {
    const file = path.join(memoryRoot, "learning.db");
    const db = seedDatabase(file, 200);
    const insert = db.prepare("INSERT INTO t (payload) VALUES (?)");

    // Keep committing on a second connection for as long as the backup runs.
    // `db.backup()` is the only copy mechanism that is defined under this.
    const writer = new Database(file);
    writer.pragma("journal_mode = WAL");
    let writing = true;
    let written = 0;
    const writerLoop = (async () => {
      const stmt = writer.prepare("INSERT INTO t (payload) VALUES (?)");
      while (writing) {
        stmt.run(`concurrent-${written}`);
        written += 1;
        await new Promise((r) => setImmediate(r));
      }
    })();

    const dest = path.join(destDir, "learning_restored.db");
    const result = await backupSqliteDatabase(file, dest);
    writing = false;
    await writerLoop;

    // The produced file stands alone: no -wal/-shm beside it, which is exactly
    // what made the old `cp` backup lossy. (Checked before anything opens it —
    // opening a WAL database recreates the sidecars.)
    expect(existsSync(`${dest}-wal`)).toBe(false);
    expect(existsSync(`${dest}-shm`)).toBe(false);
    const restoreTarget = path.join(root, "restored", "learning.db");
    mkdirSync(path.dirname(restoreTarget), { recursive: true });
    copyFileSync(dest, restoreTarget);

    // Committed-before-the-backup rows must all be there, the file must pass
    // integrity_check (backupSqliteDatabase throws otherwise) and it must be
    // readable with no -wal sidecar next to it.
    expect(result.bytes).toBeGreaterThan(0);
    const restored = countRows(dest);
    expect(restored).toBeGreaterThanOrEqual(200);
    expect(restored).toBeLessThanOrEqual(200 + written);

    // And the source is untouched: every write the writer made is still there.
    const live = countRows(file);
    expect(live).toBe(200 + written);

    // …and that lone file restores to the same content as the backup itself.
    expect(countRows(restoreTarget)).toBe(restored);

    insert.run("after");
    writer.close();
    db.close();
  });

  it("cp of a live WAL database loses committed rows — the reason .backup() exists", async () => {
    const file = path.join(memoryRoot, "cp-control.db");
    const db = seedDatabase(file, 10);
    // Commit a lot more without checkpointing: these live in the -wal file only.
    const insert = db.prepare("INSERT INTO t (payload) VALUES (?)");
    for (let i = 0; i < 2000; i += 1) insert.run(`wal-only-${i}`);

    mkdirSync(destDir, { recursive: true });
    const cpCopy = path.join(destDir, "cp-copy.db");
    copyFileSync(file, cpCopy); // exactly what the old backup.sh did
    const apiCopy = path.join(destDir, "api-copy.db");
    await backupSqliteDatabase(file, apiCopy);

    const committed = countRows(file);
    db.close();

    expect(countRows(apiCopy)).toBe(committed);
    // The cp'd main file cannot see what is still in the -wal.
    expect(countRows(cpCopy)).toBeLessThan(committed);
  });

  it("refuses a source that is not there", async () => {
    await expect(
      backupSqliteDatabase(path.join(memoryRoot, "absent.db"), path.join(destDir, "x.db")),
    ).rejects.toThrow();
  });
});

describe("backupRuntimeDatabases", () => {
  it("backs up every database with the timestamp in the name", async () => {
    for (const name of ["learning.db", "campaigns.db", "daemon.db"]) {
      seedDatabase(path.join(memoryRoot, name), 3).close();
    }
    const results = await backupRuntimeDatabases({
      memoryRoot,
      destDir,
      timestamp: "20260917_010203",
    });
    expect(results.map((r) => path.basename(r.destination)).sort()).toEqual([
      "campaigns_20260917_010203.db",
      "daemon_20260917_010203.db",
      "learning_20260917_010203.db",
    ]);
    for (const result of results) expect(countRows(result.destination)).toBe(3);
  });
});

describe("the CLI scripts/backup.sh calls", () => {
  it("parses its arguments in both forms", () => {
    expect(parseBackupArgs(["--source", "/m", "--dest", "/b"])).toEqual({
      source: "/m",
      dest: "/b",
    });
    expect(parseBackupArgs(["--source=/m", "--dest=/b", "--timestamp=t1"])).toEqual({
      source: "/m",
      dest: "/b",
      timestamp: "t1",
    });
    expect(() => parseBackupArgs(["--source", "/m"])).toThrow(/usage/);
    expect(() => parseBackupArgs(["--source"])).toThrow(/Missing value/);
  });

  it("exits 0 and names the files it wrote", async () => {
    seedDatabase(path.join(memoryRoot, "learning.db"), 2).close();
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runBackupCli(["--source", memoryRoot, "--dest", destDir, "--timestamp", "ts"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(written.join("")).toContain(path.join(destDir, "learning_ts.db"));
  });

  it("exits non-zero when the arguments are wrong", async () => {
    expect(await runBackupCli(["--dest", destDir])).toBe(2);
  });
});

describe("scripts/backup.sh", () => {
  const script = readFileSync(path.join(repoRoot, "scripts", "backup.sh"), "utf8");

  it("takes the memory root from MEMORY_DB_PATH instead of hardcoding the volume", () => {
    expect(script).toMatch(/MEMORY_DB_PATH/);
    // The default stays the same, but it IS a default now.
    expect(script).toMatch(/MEMORY_DB_PATH:-\.strada-memory/);
  });

  it("never copies a database with cp", () => {
    // Collect every shell variable whose value is built from a `.db` path
    // (`local source="${memory_root}/learning.db"`) and assert no `cp` line
    // mentions one — the old script did exactly that, WAL and all.
    const dbVars = new Set<string>();
    for (const line of script.split("\n")) {
      const assign = /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=.*\.db[^a-zA-Z]?/.exec(line);
      if (assign) dbVars.add(assign[1] as string);
    }
    const offenders = script.split("\n").filter((line) => {
      if (!/(^|\s|\|\|\s*)cp\s/.test(line)) return false;
      if (/\.db\b/.test(line)) return true;
      return [...dbVars].some((v) => line.includes(`$${v}`) || line.includes(`\${${v}}`));
    });
    expect(offenders).toEqual([]);
  });

  it("delegates database backup to the SQLite backup CLI", () => {
    expect(script).toMatch(/database-backup\.js/);
  });
});
