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
 *
 * Round 10 #22 added a fourth: the inventory only ever looked at the memory
 * root, while a default installation keeps `hub-owners.db` (which chat belongs
 * to which channel) and `trusted-skills.db` (which skills a project approved)
 * in the Strada home instead. Listing `hub-owners.db` under the memory
 * directory does not find the file that exists — so a "successful" backup
 * silently carried neither, and a restore lost every binding and every
 * approval. The inventory is now built per ROOT and each database's restore
 * location travels with it.
 *
 * Round 11 added the two this file is now mostly about:
 *
 *   #2  a restore whose backup is missing, truncated or corrupt used to DELETE
 *       the live database (and its -wal/-shm) before discovering that, so a
 *       failed restore destroyed the data it was asked to protect. Every test
 *       in "a restore whose backup is unusable" has the live database holding
 *       MORE rows than the backup does, so nothing can pass by restoring
 *       successfully.
 *
 *   #19 the inventory covered installation-owned databases only: the delivery
 *       packages a PROJECT owns and the attachment spool the large-file rows
 *       point at were both absent, so a restored machine lost every package
 *       revision and served 404s for rows still promising bytes. The fixture
 *       for that one reads a package revision back and STREAMS an attachment,
 *       which is the only proof that distinguishes "the database is intact"
 *       from "the data is there".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUP_MANIFEST_FILE,
  MEMORY_DATABASE_FILES,
  PROJECT_DATABASE_FILES,
  PROJECT_DATA_DIR,
  PROJECT_ROOT_NAME,
  RUNTIME_BLOB_DIRECTORIES,
  RUNTIME_DATABASE_FILES,
  STRADA_HOME_DATABASE_FILES,
  backupRuntimeData,
  backupRuntimeDatabases,
  backupSqliteDatabase,
  inventoryRuntimeDatabases,
  listRuntimeDatabases,
  parseBackupArgs,
  readBackupManifest,
  restoreRuntimeData,
  restoreRuntimeDatabases,
  runBackupCli,
  runtimeDatabaseRoots,
} from "./database-backup.js";
import { HubOwnerStore } from "../channels/hub/owner-store.js";
import { openSkillTrustStore } from "../skills/skill-trust.js";
import {
  PENDING_ATTACHMENT_DIR,
  RETAINED_ATTACHMENT_DIR,
  WebAttachmentStore,
  attachmentSpoolRoot,
} from "../channels/web/web-attachment-store.js";
import {
  DeliveryPackageStore,
  assembleDeliveryPackage,
} from "../campaign/delivery-package.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let root: string;
let memoryRoot: string;
/** A default installation's Strada home — `~/.strada`, beside the memory root. */
let stradaHome: string;
let destDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "strada-db-backup-"));
  memoryRoot = path.join(root, ".strada-memory");
  stradaHome = path.join(root, ".strada");
  destDir = path.join(root, "backup");
  mkdirSync(memoryRoot, { recursive: true });
  mkdirSync(stradaHome, { recursive: true });
});

/** The two roots a default installation has, with `~` pointed at the fixture. */
function defaultInstallation(): { memoryRoot: string; stradaHome: string; userHome: string } {
  return { memoryRoot, stradaHome, userHome: root };
}

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
  it("backs up every database with the timestamp in the name, filed under its root", async () => {
    for (const name of ["learning.db", "campaigns.db", "daemon.db"]) {
      seedDatabase(path.join(memoryRoot, name), 3).close();
    }
    const results = await backupRuntimeDatabases({
      ...defaultInstallation(),
      destDir,
      timestamp: "20260917_010203",
    });
    // Under `memory/`, not loose in the destination: the Strada home's
    // databases are copied into the same backup and a shared name (identity.db)
    // would otherwise overwrite (#22).
    expect(results.map((r) => path.relative(destDir, r.destination)).sort()).toEqual([
      path.join("memory", "campaigns_20260917_010203.db"),
      path.join("memory", "daemon_20260917_010203.db"),
      path.join("memory", "learning_20260917_010203.db"),
    ]);
    for (const result of results) {
      expect(countRows(result.destination)).toBe(3);
      expect(result.root).toBe("memory");
      expect(result.restorePath).toBe(path.join(memoryRoot, result.relative));
    }
  });
});

describe("a default installation's inventory (round 10 #22)", () => {
  it("backs up the Strada-home databases, not only the memory root", async () => {
    // The exact repro: hub bindings and skill approvals exist, the backup
    // reports success, and neither database is in it.
    seedDatabase(path.join(memoryRoot, "memory.db"), 3).close();
    seedDatabase(path.join(stradaHome, "hub-owners.db"), 1).close();
    seedDatabase(path.join(stradaHome, "trusted-skills.db"), 1).close();

    const results = await backupRuntimeDatabases({
      ...defaultInstallation(),
      destDir,
      timestamp: "ts",
    });

    expect(results.map((r) => path.basename(r.source)).sort()).toEqual([
      "hub-owners.db",
      "memory.db",
      "trusted-skills.db",
    ]);
  });

  it("no longer claims hub-owners.db lives under the memory root", () => {
    // Listing a name under the wrong directory is not discovery: the file it
    // names is somewhere else, so the entry never matched anything.
    expect(MEMORY_DATABASE_FILES).not.toContain("hub-owners.db");
    expect(STRADA_HOME_DATABASE_FILES).toContain("hub-owners.db");
    expect(STRADA_HOME_DATABASE_FILES).toContain("trusted-skills.db");
    // The union is still exported for anything that wants "every known name".
    expect(RUNTIME_DATABASE_FILES).toContain("hub-owners.db");
    expect(RUNTIME_DATABASE_FILES).toContain("memory.db");
  });

  it("keeps each database's root, so two roots cannot collide or overwrite", () => {
    // A name can legitimately exist in both roots; the backup has to keep them
    // apart and remember which one each came from.
    seedDatabase(path.join(memoryRoot, "identity.db"), 1).close();
    seedDatabase(path.join(stradaHome, "identity.db"), 2).close();
    const inventory = inventoryRuntimeDatabases(defaultInstallation());
    const identities = inventory.filter((f) => f.relative === "identity.db");
    expect(identities).toHaveLength(2);
    expect(identities.map((f) => f.root).sort()).toEqual(["memory", "strada-home"]);
    for (const entry of identities) {
      expect(entry.source).toBe(path.join(entry.rootPath, entry.relative));
    }
  });

  it("lists one root once when the memory root IS the Strada home", () => {
    // MEMORY_DB_PATH can point at ~/.strada itself. Backing the same file up
    // twice under two names is a restore that has to guess.
    seedDatabase(path.join(stradaHome, "memory.db"), 1).close();
    const roots = runtimeDatabaseRoots({
      memoryRoot: stradaHome,
      stradaHome,
      userHome: root,
    });
    expect(roots.map((r) => r.path)).toEqual([stradaHome]);
    const inventory = inventoryRuntimeDatabases({
      memoryRoot: stradaHome,
      stradaHome,
      userHome: root,
    });
    expect(inventory.map((f) => f.source)).toEqual([path.join(stradaHome, "memory.db")]);
  });

  it("discovers a Strada-home database the table has not caught up with yet", () => {
    seedDatabase(path.join(stradaHome, "invented-tomorrow.db"), 1).close();
    const inventory = inventoryRuntimeDatabases(defaultInstallation());
    expect(inventory.map((f) => f.relative)).toContain("invented-tomorrow.db");
  });

  it("survives a Strada home that does not exist yet", () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 1).close();
    const inventory = inventoryRuntimeDatabases({
      memoryRoot,
      stradaHome: path.join(root, "absent"),
      userHome: path.join(root, "absent-home"),
    });
    expect(inventory.map((f) => f.relative)).toEqual(["memory.db"]);
  });
});

describe("backup and restore of a default installation (round 10 #22)", () => {
  it("restores hub bindings and skill approvals to where the runtime reads them", async () => {
    // Real stores, real rows: the two things the finding says a "successful"
    // backup silently dropped.
    const hub = new HubOwnerStore(path.join(stradaHome, "hub-owners.db"));
    hub.bind("chat-42", "telegram");
    hub.close();
    const trust = openSkillTrustStore({
      path: path.join(stradaHome, "trusted-skills.db"),
      importLegacyJson: false,
    });
    trust.approve("project-1", "skill-1", {
      sha256: "deadbeef",
      approvedAtIso: "2026-09-17T00:00:00.000Z",
    });
    trust.close();
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();

    const results = await backupRuntimeDatabases({
      ...defaultInstallation(),
      destDir,
      timestamp: "ts",
    });
    expect(results).toHaveLength(3);

    // The manifest is what makes a restore possible: it records the root of
    // every file and the absolute path it came from.
    const manifest = readBackupManifest(destDir);
    expect(existsSync(path.join(destDir, BACKUP_MANIFEST_FILE))).toBe(true);
    expect(manifest.roots["memory"]).toBe(memoryRoot);
    expect(manifest.roots["strada-home"]).toBe(stradaHome);
    expect(manifest.databases.map((d) => d.relative).sort()).toEqual([
      "hub-owners.db",
      "memory.db",
      "trusted-skills.db",
    ]);

    // Restore onto a fresh machine whose roots are elsewhere.
    const newMemory = path.join(root, "restored", ".strada-memory");
    const newHome = path.join(root, "restored", ".strada");
    const restored = await restoreRuntimeDatabases({
      backupDir: destDir,
      roots: { memory: newMemory, "strada-home": newHome },
    });
    expect(restored.map((r) => r.destination).sort()).toEqual(
      [
        path.join(newHome, "hub-owners.db"),
        path.join(newHome, "trusted-skills.db"),
        path.join(newMemory, "memory.db"),
      ].sort(),
    );

    const restoredHub = new HubOwnerStore(path.join(newHome, "hub-owners.db"));
    expect(restoredHub.load().get("chat-42")).toBe("telegram");
    restoredHub.close();
    const restoredTrust = openSkillTrustStore({
      path: path.join(newHome, "trusted-skills.db"),
      importLegacyJson: false,
    });
    expect(restoredTrust.get("project-1", "skill-1")?.sha256).toBe("deadbeef");
    restoredTrust.close();
    expect(countRows(path.join(newMemory, "memory.db"))).toBe(7);
  });

  it("restores to the recorded locations when no override is given", async () => {
    seedDatabase(path.join(stradaHome, "hub-owners.db"), 4).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    // Wipe the live file: a restore has to be able to put it back unaided.
    rmSync(path.join(stradaHome, "hub-owners.db"), { force: true });
    const restored = await restoreRuntimeDatabases({ backupDir: destDir });
    expect(restored.map((r) => r.destination)).toEqual([
      path.join(stradaHome, "hub-owners.db"),
    ]);
    expect(countRows(path.join(stradaHome, "hub-owners.db"))).toBe(4);
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
    expect(
      parseBackupArgs(["--source", "/m", "--dest", "/b", "--strada-home", "/h", "--user-home", "/u"]),
    ).toEqual({ source: "/m", dest: "/b", stradaHome: "/h", userHome: "/u" });
    expect(() => parseBackupArgs(["--source", "/m"])).toThrow(/usage/);
    expect(() => parseBackupArgs(["--source"])).toThrow(/Missing value/);
  });

  it("exits 0 and names the files it wrote, the manifest included", async () => {
    seedDatabase(path.join(memoryRoot, "learning.db"), 2).close();
    seedDatabase(path.join(stradaHome, "hub-owners.db"), 1).close();
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      // --strada-home/--user-home keep the CLI off the machine's real ~/.strada;
      // without them it reads the installation it is actually running on, which
      // is the whole point of the flagless default.
      const code = await runBackupCli([
        "--source",
        memoryRoot,
        "--dest",
        destDir,
        "--timestamp",
        "ts",
        "--strada-home",
        stradaHome,
        "--user-home",
        root,
      ]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const out = written.join("");
    expect(out).toContain(path.join(destDir, "memory", "learning_ts.db"));
    expect(out).toContain(path.join(destDir, "strada-home", "hub-owners_ts.db"));
    expect(out).toContain(path.join(destDir, BACKUP_MANIFEST_FILE));
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

  it("does not abandon the backup when the memory root is absent (#22)", () => {
    // The databases that hold hub bindings and skill approvals live in the
    // Strada home, so "no memory directory" is not "nothing to back up". The
    // early `return 0` on a missing memory root skipped those too.
    const fn = /backup_databases\(\)\s*\{[\s\S]*?\n\}/.exec(script)?.[0] ?? "";
    expect(fn, "backup_databases() not found").not.toBe("");
    const memoryGuard = /!\s*-d\s+"\$memory_root"[\s\S]{0,200}?\n\s*fi/.exec(fn)?.[0] ?? "";
    expect(memoryGuard, "no missing-memory-root branch at all").not.toBe("");
    expect(memoryGuard).not.toMatch(/return\s+0/);
  });
});

/**
 * ROUND 11 #2 — a restore must never be the thing that loses the data.
 *
 * The old restore deleted the destination and its -wal/-shm and THEN opened the
 * backup: a manifest naming a missing, truncated or corrupt file destroyed a
 * perfectly good live database and threw afterwards. Every test below has the
 * live database holding MORE than the backup does, so "it still holds what it
 * held" cannot be satisfied by accidentally restoring successfully.
 */
describe("a restore whose backup is unusable (round 11 #2)", () => {
  /** A backup of `memory.db` at 7 rows, with the live file then moved on to 12. */
  async function backupThenDivergeLive(): Promise<string> {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 5).close();
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
    return path.join(destDir, "memory", "memory_ts.db");
  }

  it("keeps the live database and its rows when the backup file is missing", async () => {
    await backupThenDivergeLive();
    rmSync(path.join(destDir, "memory", "memory_ts.db"), { force: true });

    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
      /is missing from the backup/,
    );
    // The exact repro: before the fix the file was already gone here.
    expect(existsSync(path.join(memoryRoot, "memory.db"))).toBe(true);
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
  });

  it("names the destination it refused to replace and why", async () => {
    await backupThenDivergeLive();
    rmSync(path.join(destDir, "memory", "memory_ts.db"), { force: true });
    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
      new RegExp(`${path.join(memoryRoot, "memory.db").replace(/[.\\]/g, "\\$&")}`),
    );
    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
      /Nothing was replaced/,
    );
  });

  it("keeps the live database and its rows when the backup is corrupt", async () => {
    const backupFile = await backupThenDivergeLive();
    // Same length, not a database: the size alone cannot catch this one.
    writeFileSync(backupFile, Buffer.alloc(statSync(backupFile).size, 0x41));

    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
      /not a usable SQLite database|failed integrity_check|cannot be opened/,
    );
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
  });

  it("keeps the live database when the backup has been truncated", async () => {
    // SQLite opens a zero-byte file as a valid EMPTY database and
    // integrity_check says ok, so a truncated backup would restore a database
    // with no rows and report success.
    const backupFile = await backupThenDivergeLive();
    writeFileSync(backupFile, Buffer.alloc(0));

    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
      /the backup file changed/,
    );
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
  });

  it("replaces nothing when a later destination cannot be written", async () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 3).close();
    seedDatabase(path.join(stradaHome, "hub-owners.db"), 4).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    // Both live databases have moved on since the backup.
    seedDatabase(path.join(memoryRoot, "memory.db"), 30).close();
    seedDatabase(path.join(stradaHome, "hub-owners.db"), 40).close();

    chmodSync(stradaHome, 0o500);
    try {
      await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
        /while staging the replacements[\s\S]*Nothing was replaced/,
      );
    } finally {
      chmodSync(stradaHome, 0o700);
    }
    // The FIRST database — the one whose destination was perfectly writable —
    // must not have been replaced either: one unusable destination aborts the
    // whole restore.
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(33);
    expect(countRows(path.join(stradaHome, "hub-owners.db"))).toBe(44);
    expect(readdirSync(memoryRoot).filter((n) => n.includes(".restore-"))).toEqual([]);
  });

  it("puts back a database it had already replaced when a later swap fails", async () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 3).close();
    seedDatabase(path.join(stradaHome, "hub-owners.db"), 4).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 30).close();
    seedDatabase(path.join(stradaHome, "hub-owners.db"), 40).close();

    // The one window nothing outside can provoke: every replacement is staged
    // and the first one is already in place when the second destination becomes
    // unwritable. A restore that cannot finish must not be half applied.
    try {
      await expect(
        restoreRuntimeDatabases({
          backupDir: destDir,
          onStaged: () => {
            chmodSync(stradaHome, 0o500);
          },
        }),
      ).rejects.toThrow(/rolled back to what it held before/);
    } finally {
      chmodSync(stradaHome, 0o700);
    }
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(33);
    expect(countRows(path.join(stradaHome, "hub-owners.db"))).toBe(44);
  });

  it("leaves no staging or pre-restore residue behind a restore that worked", async () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 5).close();

    await restoreRuntimeDatabases({ backupDir: destDir });
    // Checked BEFORE anything opens the file: opening a WAL database recreates
    // the sidecars a restore is supposed to have left absent.
    expect(readdirSync(memoryRoot).sort()).toEqual(["memory.db"]);
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(7);
  });
});

/**
 * ROUND 11 #19 — the bytes a row promises are part of the backup.
 *
 * Two things a restored installation used to come back without: the delivery
 * packages a PROJECT owns (`<projectRoot>/.strada/delivery-packages.db`, which
 * is under neither backed-up root) and the attachment spool the large-file rows
 * point at by absolute path.
 */
describe("project-owned databases (round 11 #19)", () => {
  it("inventories <projectRoot>/.strada, and only when a project root is given", () => {
    const projectRoot = path.join(root, "project");
    mkdirSync(path.join(projectRoot, PROJECT_DATA_DIR), { recursive: true });
    seedDatabase(path.join(projectRoot, PROJECT_DATA_DIR, "delivery-packages.db"), 2).close();

    const entry = inventoryRuntimeDatabases({ ...defaultInstallation(), projectRoot }).find(
      (f) => f.relative === "delivery-packages.db",
    );
    expect(entry?.root).toBe(PROJECT_ROOT_NAME);
    expect(entry?.rootPath).toBe(path.join(projectRoot, PROJECT_DATA_DIR));
    // The repro: an installation-only inventory has no project root at all, so
    // the file is out of scope rather than merely missing.
    expect(
      inventoryRuntimeDatabases(defaultInstallation()).map((f) => f.relative),
    ).not.toContain("delivery-packages.db");
  });

  it("keeps the project's known names when its .strada IS the Strada home", () => {
    // One directory, two labels: deduplicating it must not drop the loser's
    // known names — `delivery-packages.db` would then only be found by the
    // `*.db` sweep, which is not a contract.
    const roots = runtimeDatabaseRoots({ memoryRoot, stradaHome, userHome: root, projectRoot: root });
    expect(roots.map((r) => r.path)).toEqual([memoryRoot, stradaHome]);
    expect(roots.find((r) => r.path === stradaHome)?.known).toEqual(
      expect.arrayContaining(["hub-owners.db", "trusted-skills.db", "delivery-packages.db"]),
    );
  });

  it("backs the project's databases up under their own root", async () => {
    const projectRoot = path.join(root, "project");
    mkdirSync(path.join(projectRoot, PROJECT_DATA_DIR), { recursive: true });
    seedDatabase(path.join(projectRoot, PROJECT_DATA_DIR, "delivery-packages.db"), 2).close();
    const run = await backupRuntimeData({
      ...defaultInstallation(),
      projectRoot,
      destDir,
      timestamp: "ts",
    });
    expect(run.databases.map((r) => path.relative(destDir, r.destination))).toContain(
      path.join(PROJECT_ROOT_NAME, "delivery-packages_ts.db"),
    );
    expect(run.manifest.roots[PROJECT_ROOT_NAME]).toBe(path.join(projectRoot, PROJECT_DATA_DIR));
  });
});

describe("retained attachment bytes (round 11 #19)", () => {
  /** A retained (too large to inline) attachment, with the source then deleted. */
  function registerRetained(payload: Buffer): { token: string; spoolFile: string } {
    const source = path.join(root, "recording.bin");
    writeFileSync(source, payload);
    const store = new WebAttachmentStore(
      path.join(memoryRoot, "web-attachments.db"),
      3_600_000,
      200,
      64,
    );
    try {
      const token = store.register({ name: "recording.bin", path: source });
      const entry = store.get(token);
      // Retained, not inlined: this test is about the bytes that live OUTSIDE
      // the database. WHERE inside the spool is the store's business (each
      // database owns a subdirectory of it), so this asserts the contract, not
      // a layout: under the spool root, named by the token.
      expect(entry?.retained).toBe(true);
      expect(entry!.path!.startsWith(path.join(memoryRoot, RETAINED_ATTACHMENT_DIR) + path.sep)).toBe(
        true,
      );
      expect(path.basename(entry!.path!)).toBe(token);
      return { token, spoolFile: entry!.path! };
    } finally {
      store.close();
      // What a recording pipeline does the moment it is done.
      rmSync(source, { force: true });
    }
  }

  /** The bytes a link would serve, read the way the serve path reads them. */
  function serveBytes(dbPath: string, token: string): Buffer {
    const store = new WebAttachmentStore(dbPath, 3_600_000, 200, 64);
    try {
      const entry = store.get(token);
      expect(entry, "the attachment row did not survive the restore").not.toBeNull();
      const open = store.openStoredFile(entry!);
      expect(open, "the registered bytes are not where the row says they are").not.toBeNull();
      const buffer = Buffer.alloc(open!.sizeBytes);
      readSync(open!.fd, buffer, 0, buffer.length, 0);
      closeSync(open!.fd);
      return buffer;
    } finally {
      store.close();
    }
  }

  it("records every retained blob in the manifest with its digest", async () => {
    const payload = Buffer.alloc(4096, 0x7a);
    const { spoolFile } = registerRetained(payload);
    const run = await backupRuntimeData({ ...defaultInstallation(), destDir, timestamp: "ts" });

    expect(run.blobs.map((b) => b.relative)).toEqual([path.relative(memoryRoot, spoolFile)]);
    const blob = readBackupManifest(destDir).blobs?.[0];
    expect(blob?.root).toBe("memory");
    expect(blob?.bytes).toBe(payload.length);
    expect(blob?.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    // And the copy inside the backup keeps the spool's privacy.
    expect(statSync(path.join(destDir, blob!.backup)).mode & 0o777).toBe(0o600);
  });

  it("recovers a delivery-package revision and an attachment's bytes on a fresh root", async () => {
    // The exit criterion of #19, both halves at once: deliver a campaign,
    // register a large attachment, back up, restore onto a machine where every
    // root is somewhere else.
    const projectRoot = path.join(root, "project");
    const packages = new DeliveryPackageStore(
      path.join(projectRoot, PROJECT_DATA_DIR, "delivery-packages.db"),
    );
    const stored = packages.put(
      assembleDeliveryPackage({
        campaign: {
          id: "campaign_11",
          projectRoot,
          state: "done",
          milestones: [],
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    );
    packages.close();

    const payload = Buffer.alloc(9000, 0x2b);
    const { token, spoolFile } = registerRetained(payload);

    await backupRuntimeData({ ...defaultInstallation(), projectRoot, destDir, timestamp: "ts" });

    // A CLEAN machine: the installation the backup came from is gone. Deleting
    // it is what makes this test about the restore — with the old directories
    // still lying there, a row that was never rebased serves its bytes from the
    // old absolute path and the test passes while the defect is intact.
    rmSync(memoryRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });

    const fresh = path.join(root, "fresh");
    const freshMemory = path.join(fresh, ".strada-memory");
    const freshProject = path.join(fresh, "project", PROJECT_DATA_DIR);
    const restored = await restoreRuntimeData({
      backupDir: destDir,
      roots: { memory: freshMemory, [PROJECT_ROOT_NAME]: freshProject },
    });
    // Same place within the new root as it held within the old one.
    expect(restored.blobs.map((b) => b.destination)).toEqual([
      path.join(freshMemory, path.relative(memoryRoot, spoolFile)),
    ]);

    // The package revision is readable, by revision and by campaign.
    const restoredPackages = new DeliveryPackageStore(path.join(freshProject, "delivery-packages.db"));
    try {
      expect(restoredPackages.latest("campaign_11")?.revision).toBe(stored.revision);
      expect(restoredPackages.get("campaign_11", stored.revision)?.documentSha256).toBe(
        stored.documentSha256,
      );
    } finally {
      restoredPackages.close();
    }

    // …and the attachment STREAMS. The row has to name the NEW spool: its
    // recorded path was an absolute path on a machine that no longer exists, and
    // a row pointing there is a link that 404s while still promising the bytes.
    const freshDb = path.join(freshMemory, "web-attachments.db");
    const rebased = (() => {
      const store = new WebAttachmentStore(freshDb, 3_600_000, 200, 64);
      try {
        return store.get(token)!.path!;
      } finally {
        store.close();
      }
    })();
    expect(rebased.startsWith(path.join(freshMemory, RETAINED_ATTACHMENT_DIR) + path.sep)).toBe(true);
    expect(rebased).not.toBe(spoolFile);
    expect(existsSync(spoolFile)).toBe(false);
    expect(serveBytes(freshDb, token).equals(payload)).toBe(true);
  });

  it("restores the spool as 0700 directories of 0600 files", async () => {
    // The store's guarantee about retained bytes — "the spool is 0700 and the
    // copy 0600, so that is not another process" — must survive the restore
    // that recreated them.
    const { spoolFile } = registerRetained(Buffer.alloc(4096, 0x31));
    await backupRuntimeData({ ...defaultInstallation(), destDir, timestamp: "ts" });
    const freshMemory = path.join(root, "fresh", ".strada-memory");
    await restoreRuntimeData({ backupDir: destDir, roots: { memory: freshMemory } });

    const restoredFile = path.join(freshMemory, path.relative(memoryRoot, spoolFile));
    expect(statSync(restoredFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(restoredFile)).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(freshMemory, RETAINED_ATTACHMENT_DIR)).mode & 0o777).toBe(0o700);
  });

  it("leaves the staging directory out: nothing names those bytes yet", async () => {
    // A file in `incoming` has no row (that is what pending means), the store's
    // own sweep deletes it, and it may be a recording halfway through being
    // copied right now — which the backup's digest check would read as a corrupt
    // copy and fail the whole run over.
    const { spoolFile } = registerRetained(Buffer.alloc(2048, 0x44));
    const pending = path.join(path.dirname(spoolFile), PENDING_ATTACHMENT_DIR);
    mkdirSync(pending, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(pending, "half-written-token"), Buffer.alloc(16, 0x45));

    const run = await backupRuntimeData({ ...defaultInstallation(), destDir, timestamp: "ts" });
    expect(run.blobs.map((b) => b.relative)).toEqual([path.relative(memoryRoot, spoolFile)]);
  });

  it("refuses a restore whose blob bytes are not the ones recorded, keeping the live spool", async () => {
    const payload = Buffer.alloc(4096, 0x5f);
    const { token, spoolFile } = registerRetained(payload);
    await backupRuntimeData({ ...defaultInstallation(), destDir, timestamp: "ts" });
    // Same length, different bytes — and a restore that placed these would
    // serve them under the row's recorded checksum, which is the one thing the
    // store guarantees it never does.
    const blob = readBackupManifest(destDir).blobs![0]!;
    writeFileSync(path.join(destDir, blob.backup), Buffer.alloc(payload.length, 0x60));

    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
      /hashes [0-9a-f]{64} where the manifest recorded/,
    );
    // The live installation is untouched: same bytes, still servable.
    expect(readFileSync(spoolFile).equals(payload)).toBe(true);
    expect(
      serveBytes(path.join(memoryRoot, "web-attachments.db"), token).equals(payload),
    ).toBe(true);
  });
});

describe("the contract with the stores that own these files (round 11 #19)", () => {
  it("backs up the path CampaignManager opens, not a path retyped here", () => {
    const manager = readFileSync(
      path.join(repoRoot, "src", "campaign", "campaign-manager.ts"),
      "utf8",
    );
    // If the delivery-package store moves, this fails and the inventory follows
    // it — the alternative is a backup that silently stops covering it.
    expect(manager).toContain(
      `join(this.projectRoot, "${PROJECT_DATA_DIR}", "${PROJECT_DATABASE_FILES[0]}")`,
    );
  });

  it("backs up the directory the store calls the one to back up", () => {
    // `attachmentSpoolRoot` IS the contract ("the path to back up or prune: it
    // covers all databases in that directory"). Asserting against the function
    // rather than the constant is what makes a move of the spool fail here.
    const spoolRoot = attachmentSpoolRoot(path.join(memoryRoot, "web-attachments.db"));
    expect(RUNTIME_BLOB_DIRECTORIES.map((dir) => path.join(memoryRoot, dir))).toContain(spoolRoot);
  });
});

describe("the CLI and scripts/backup.sh for project data (round 11 #19)", () => {
  const script = readFileSync(path.join(repoRoot, "scripts", "backup.sh"), "utf8");

  it("parses --project-root", () => {
    expect(parseBackupArgs(["--source", "/m", "--dest", "/b", "--project-root", "/p"])).toEqual({
      source: "/m",
      dest: "/b",
      projectRoot: "/p",
    });
  });

  it("prints the blob files it wrote so the caller checksums them too", async () => {
    const spoolFile = (() => {
      const source = path.join(root, "big.bin");
      writeFileSync(source, Buffer.alloc(2048, 0x11));
      const store = new WebAttachmentStore(
        path.join(memoryRoot, "web-attachments.db"),
        3_600_000,
        200,
        64,
      );
      const token = store.register({ name: "big.bin", path: source });
      const file = store.get(token)!.path!;
      store.close();
      rmSync(source, { force: true });
      return file;
    })();
    const projectRoot = path.join(root, "project");
    mkdirSync(path.join(projectRoot, PROJECT_DATA_DIR), { recursive: true });
    seedDatabase(path.join(projectRoot, PROJECT_DATA_DIR, "delivery-packages.db"), 1).close();

    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(
        await runBackupCli([
          "--source",
          memoryRoot,
          "--dest",
          destDir,
          "--timestamp",
          "ts",
          "--strada-home",
          stradaHome,
          "--user-home",
          root,
          "--project-root",
          projectRoot,
        ]),
      ).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const out = written.join("");
    expect(out).toContain(path.join(destDir, PROJECT_ROOT_NAME, "delivery-packages_ts.db"));
    expect(out).toContain(path.join(destDir, "memory", path.relative(memoryRoot, spoolFile)));
  });

  it("gives the CLI the project root the runtime itself reads", () => {
    // Same reasoning as MEMORY_DB_PATH: the script must read the variable the
    // application reads, not a path of its own.
    expect(script).toMatch(/UNITY_PROJECT_PATH/);
    expect(script).toMatch(/--project-root/);
  });

  it("says the delivery packages are absent instead of reporting a complete backup", () => {
    const fn = /backup_databases\(\)\s*\{[\s\S]*?\n\}/.exec(script)?.[0] ?? "";
    expect(fn, "backup_databases() not found").not.toBe("");
    expect(fn).toMatch(/delivery-packages\.db/);
  });
});
