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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  MAINTENANCE_LOCK_FILE,
  acquireMaintenanceExclusion,
  assertNoMaintenanceExclusion,
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
import { kernelEnforcesPermissions, permissionDenied } from "../tests/helpers/permission-faults.js";

/**
 * The directory {@link makeReadOnly} has made read-only by injection. Root
 * ignores permission bits (Docker CI, root dev containers) and Windows has no
 * POSIX modes, so there `chmod 0o500` stops nothing; the same EACCES is raised
 * instead at the writes a restore makes into a destination directory:
 * `renameSync` moving a live file aside or into place (here) and SQLite
 * creating the staged copy (`db.backup()`, spied in makeReadOnly).
 */
const readOnly = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { dirname } = await import("node:path");
  const inReadOnlyDir = (p: unknown): boolean => readOnly.dir !== undefined && dirname(String(p)) === readOnly.dir;
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (inReadOnlyDir(from) || inReadOnlyDir(to)) throw permissionDenied("rename", from);
    actual.renameSync(from, to);
  };
  return { ...actual, renameSync };
});

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
  readOnly.dir = undefined;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Make `dir` read-only to this process and return the undo: `chmod 0o500`
 * wherever the kernel enforces it, the injected EACCES (see `readOnly`) where
 * it does not.
 */
function makeReadOnly(dir: string): () => void {
  if (kernelEnforcesPermissions) {
    chmodSync(dir, 0o500);
    return () => chmodSync(dir, 0o700);
  }
  readOnly.dir = dir;
  const realBackup = Database.prototype.backup;
  const backup = vi
    .spyOn(Database.prototype, "backup")
    .mockImplementation(function (this: Database.Database, destination: string, options?: Database.BackupOptions) {
      if (path.dirname(destination) === dir) return Promise.reject(permissionDenied("open", destination));
      return realBackup.call(this, destination, options);
    });
  return () => {
    readOnly.dir = undefined;
    backup.mockRestore();
  };
}

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

    const restoreWritable = makeReadOnly(stradaHome);
    try {
      await expect(
        // The maintenance exclusion (round 12 #22) is taken in the Strada home,
        // which this case deliberately makes unwritable; it is redirected so the
        // subject stays "a DESTINATION that cannot be written".
        restoreRuntimeDatabases({ backupDir: destDir, maintenanceDir: path.join(root, "maint") }),
      ).rejects.toThrow(/while staging the replacements[\s\S]*Nothing was replaced/);
    } finally {
      restoreWritable();
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
    let restoreWritable = (): void => {};
    try {
      await expect(
        restoreRuntimeDatabases({
          backupDir: destDir,
          maintenanceDir: path.join(root, "maint"),
          onStaged: () => {
            restoreWritable = makeReadOnly(stradaHome);
          },
        }),
      ).rejects.toThrow(/rolled back to what it held before/);
    } finally {
      restoreWritable();
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

/**
 * ROUND 12 #19-#22 — a restore must not be a way to destroy live data.
 *
 * Every case here asserts the BYTES on disk, not a return value: the whole
 * class of defect is a driver that reports success (or throws) after the
 * operator's files are already gone.
 */
describe("a manifest that has been modified (round 12 #19)", () => {
  /** Rewrite the manifest of the backup in `destDir`. */
  function tamperManifest(mutate: (manifest: Record<string, any>) => void): void {
    const file = path.join(destDir, BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    mutate(manifest);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /** memory.db backed up at 7 rows, the live file moved on to 12. */
  async function backupAndDiverge(): Promise<void> {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 5).close();
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
  }

  it("refuses a relative path that climbs out of its root, keeping the victim's bytes", async () => {
    await backupAndDiverge();
    const victim = path.join(root, "victim", "important.db");
    mkdirSync(path.dirname(victim), { recursive: true });
    writeFileSync(victim, "a file this backup was never given permission to replace\n");
    const victimBytes = readFileSync(victim);

    tamperManifest((m) => {
      m.databases[0].relative = path.join("..", "victim", "important.db");
    });

    const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
      () => null,
      (err: Error) => err,
    );
    // The BYTES first: before the fix these were a SQLite database.
    expect(readFileSync(victim)).toEqual(victimBytes);
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
    expect(outcome?.message).toMatch(/outside the root/);
  });

  it("refuses a member path that climbs out of the backup directory", async () => {
    await backupAndDiverge();
    // A database the manifest points at from OUTSIDE the backup: valid SQLite,
    // the right size, and not part of what was backed up.
    const foreign = path.join(root, "outside", "foreign.db");
    mkdirSync(path.dirname(foreign), { recursive: true });
    seedDatabase(foreign, 3).close();
    tamperManifest((m) => {
      m.databases[0].backup = path.relative(destDir, foreign);
      m.databases[0].bytes = statSync(foreign).size;
    });

    const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
      () => null,
      (err: Error) => err,
    );
    // The ROWS first: before the fix the live database held the foreign three.
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
    expect(outcome?.message).toMatch(/outside the backup/);
  });

  it("refuses a manifest entry that is not the shape an entry has", async () => {
    await backupAndDiverge();
    tamperManifest((m) => {
      m.databases[0].relative = { escape: "../../victim" };
    });

    expect(() => readBackupManifest(destDir)).toThrow(/relative/);
    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(/relative/);
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
  });

  it("refuses a destination whose directory is a symlink out of the root", async () => {
    await backupAndDiverge();
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const victim = path.join(elsewhere, "memory.db");
    writeFileSync(victim, "outside the root, reached through a symlink inside it\n");
    const victimBytes = readFileSync(victim);
    symlinkSync(elsewhere, path.join(memoryRoot, "sub"));

    tamperManifest((m) => {
      m.databases[0].relative = path.join("sub", "memory.db");
    });

    const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
      () => null,
      (err: Error) => err,
    );
    expect(readFileSync(victim)).toEqual(victimBytes);
    expect(outcome?.message).toMatch(/outside the root/);
  });
});

describe("a manifest with two entries for one destination (round 12 #20)", () => {
  function tamperManifest(mutate: (manifest: Record<string, any>) => void): void {
    const file = path.join(destDir, BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    mutate(manifest);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  it("refuses a duplicated blob entry instead of deleting the live blob", async () => {
    const spoolFile = path.join(memoryRoot, RETAINED_ATTACHMENT_DIR, "store", "tok-1");
    mkdirSync(path.dirname(spoolFile), { recursive: true, mode: 0o700 });
    writeFileSync(spoolFile, Buffer.alloc(2048, 0x41), { mode: 0o600 });
    await backupRuntimeData({ ...defaultInstallation(), destDir, timestamp: "ts" });
    // The live bytes have moved on since the backup, so nothing can pass by
    // restoring successfully.
    const liveBytes = Buffer.alloc(2048, 0x42);
    writeFileSync(spoolFile, liveBytes, { mode: 0o600 });

    tamperManifest((m) => {
      m.blobs.push({ ...m.blobs[0] });
    });

    const outcome = await restoreRuntimeData({ backupDir: destDir }).then(
      () => null,
      (err: Error) => err,
    );
    // The repro, bytes first: before the fix NEITHER the original nor the
    // restored copy survived — the second swap overwrote the aside and the
    // rollback deleted the destination.
    expect(existsSync(spoolFile)).toBe(true);
    expect(readFileSync(spoolFile)).toEqual(liveBytes);
    expect(outcome?.message).toMatch(/twice/);
  });

  it("refuses a duplicated database entry instead of deleting the live database", async () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 5).close();
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);

    tamperManifest((m) => {
      m.databases.push({ ...m.databases[0] });
    });

    const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
      () => null,
      (err: Error) => err,
    );
    expect(existsSync(path.join(memoryRoot, "memory.db"))).toBe(true);
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
    expect(outcome?.message).toMatch(/twice/);
  });
});

describe("a backup taken mid-registration (round 12 #21)", () => {
  /** Register a retained attachment and return its token, row path and bytes. */
  function registerRetained(payload: Buffer): { token: string; rowPath: string } {
    const source = path.join(root, "clip.bin");
    writeFileSync(source, payload);
    const store = new WebAttachmentStore(
      path.join(memoryRoot, "web-attachments.db"),
      3_600_000,
      200,
      64,
    );
    try {
      const token = store.register({ name: "clip.bin", path: source });
      const entry = store.get(token);
      expect(entry?.retained).toBe(true);
      return { token, rowPath: entry!.path! };
    } finally {
      store.close();
      rmSync(source, { force: true });
    }
  }

  /** The bytes a link would serve, read the way the serve path reads them. */
  function serveBytes(dbPath: string, token: string): Buffer | null {
    const store = new WebAttachmentStore(dbPath, 3_600_000, 200, 64);
    try {
      const entry = store.get(token);
      if (entry === null) return null;
      const open = store.openStoredFile(entry);
      if (open === null) return null;
      const buffer = Buffer.alloc(open.sizeBytes);
      readSync(open.fd, buffer, 0, buffer.length, 0);
      closeSync(open.fd);
      return buffer;
    } finally {
      store.close();
    }
  }

  /**
   * The exact window `register()` leaves open: the row is COMMITTED and the
   * bytes are still under `incoming/`, where the backup deliberately does not
   * look. Recreated by putting the file back where the rename took it from.
   */
  function rewindToPreRename(rowPath: string, token: string): string {
    // `<spool>/incoming/<token>` — where `snapshot()` wrote the copy and
    // `register()` renames it FROM, derived from the row, not from a layout
    // retyped here.
    const staged = path.join(path.dirname(rowPath), PENDING_ATTACHMENT_DIR, token);
    mkdirSync(path.dirname(staged), { recursive: true, mode: 0o700 });
    renameSync(rowPath, staged);
    expect(existsSync(rowPath)).toBe(false);
    return staged;
  }

  it("captures the bytes a committed row promises, staged or not", async () => {
    const payload = Buffer.alloc(4096, 0x5b);
    const { token, rowPath } = registerRetained(payload);
    const staged = rewindToPreRename(rowPath, token);
    expect(existsSync(staged)).toBe(true);

    await backupRuntimeData({ ...defaultInstallation(), destDir, timestamp: "ts" });

    // Restored onto a machine where the root is elsewhere: the only proof that
    // distinguishes "the row is there" from "the bytes are there".
    const newMemory = path.join(root, "restored", ".strada-memory");
    await restoreRuntimeData({ backupDir: destDir, roots: { memory: newMemory } });
    expect(serveBytes(path.join(newMemory, "web-attachments.db"), token)).toEqual(payload);
  });

  it("fails instead of reporting a backup whose row has no bytes anywhere", async () => {
    const payload = Buffer.alloc(4096, 0x5c);
    const { token, rowPath } = registerRetained(payload);
    // Bytes gone from the spool entirely, the row still promising them.
    rmSync(rowPath, { force: true });

    await expect(
      backupRuntimeData({ ...defaultInstallation(), destDir, timestamp: "ts" }),
    ).rejects.toThrow(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  });

  it("records the gap in the manifest when the operator backs up anyway", async () => {
    const payload = Buffer.alloc(4096, 0x5d);
    const { token, rowPath } = registerRetained(payload);
    rmSync(rowPath, { force: true });

    const run = await backupRuntimeData({
      ...defaultInstallation(),
      destDir,
      timestamp: "ts",
      allowMissingBlobs: true,
    });
    expect(run.manifest.missingBlobs?.map((m) => m.token)).toEqual([token]);
    expect(readBackupManifest(destDir).missingBlobs?.[0]?.source).toBe(rowPath);
  });
});

describe("a restore while a database is in use (round 12 #22)", () => {
  it("refuses while a connection is attached, and the live rows stay put", async () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    // A database user, holding the connections a daemon holds.
    const live = seedDatabase(path.join(memoryRoot, "memory.db"), 5);
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);

    const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
      () => null,
      (err: Error) => err,
    );
    // The repro: the files were renamed out from under the open connection and
    // the restore reported success.
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
    expect(outcome?.message).toMatch(/still in use/);

    // And it is a gate, not a wall: once the user closes, the same restore runs.
    live.close();
    await restoreRuntimeDatabases({ backupDir: destDir });
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(7);
  });

  it("holds an installation-wide exclusion, so a second restore cannot interleave", async () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 5).close();

    let second: Error | undefined;
    await restoreRuntimeDatabases({
      backupDir: destDir,
      onStaged: async () => {
        second = await restoreRuntimeDatabases({ backupDir: destDir }).then(
          () => undefined,
          (err: Error) => err,
        );
      },
    });

    expect(second?.message).toMatch(/maintenance/i);
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(7);
    expect(existsSync(path.join(stradaHome, MAINTENANCE_LOCK_FILE))).toBe(false);
  });

  /**
   * Round 13 #19 reversed this deliberately. Automatic reclaim was
   * "read the holder, see it is dead, unlink, create ours", and two processes
   * doing that to one dead lock end with the second DELETING the first's live
   * claim — both then restore over the same files. A dead holder is now a
   * refusal that names the file to remove; see the round-13 block below for the
   * refusal, the race and the live rows it protects.
   */
  it("refuses an exclusion whose holder is no longer running, rather than racing to reclaim it", async () => {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 5).close();
    writeFileSync(
      path.join(stradaHome, MAINTENANCE_LOCK_FILE),
      JSON.stringify({ pid: 999_999_999, startedAtIso: "2026-01-01T00:00:00.000Z", purpose: "restore" }),
    );

    await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
      /NOT reclaimed automatically/,
    );
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
  });
});

/**
 * ROUND 13 #18-#21 — the four ways a restore could still lose the bytes it was
 * pointed at. Every test here asserts ROWS ON DISK, and every refusal is
 * measured by the live database still holding what it held before.
 */
describe("a restore that must not destroy live data (round 13)", () => {
  /** A live database with 12 rows and a backup that holds 7. */
  async function backupSevenLiveTwelve(): Promise<void> {
    seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
    await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
    seedDatabase(path.join(memoryRoot, "memory.db"), 5).close();
    expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
  }

  /** Every leftover of a restore, so "nothing was replaced" can be measured. */
  function residue(dir: string): string[] {
    return readdirSync(dir).filter((n) => n.includes(".restore-") || n.includes(".pre-restore-"));
  }

  describe("#18 — a user that attaches after the probe and before the swap", () => {
    it("refuses, and the rows that connection wrote are still there", async () => {
      await backupSevenLiveTwelve();

      let live: Database.Database | undefined;
      const outcome = await restoreRuntimeDatabases({
        backupDir: destDir,
        // The window: staged and verified, nothing replaced yet. A daemon that
        // starts HERE holds the inode the swap is about to rename away.
        onStaged: () => {
          live = new Database(path.join(memoryRoot, "memory.db"));
          live.pragma("journal_mode = WAL");
          live.prepare("INSERT INTO t (payload) VALUES ('written after the probe')").run();
        },
      }).then(
        () => null,
        (err: Error) => err,
      );
      live?.close();

      expect(outcome?.message).toMatch(/still in use/);
      expect(outcome?.message).toMatch(/nothing was replaced/i);
      // The repro: the swap happened anyway, so this read 7 — the backup's rows —
      // and the row the live connection had just committed was in a
      // `.pre-restore-` file the restore then deleted.
      expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(13);
      expect(residue(memoryRoot)).toEqual([]);
    });

    it("lets a store open the database again once the exclusion is gone", async () => {
      const dir = path.join(root, "guarded");
      mkdirSync(dir, { recursive: true });
      const held = acquireMaintenanceExclusion(dir, "restore");
      try {
        // A runtime opener consults the same file the restore claims. Only a
        // LIVE holder blocks it: a lock left by a dead process must never wedge
        // the daemon out of its own databases.
        expect(() => assertNoMaintenanceExclusion(dir, "open learning.db")).toThrow(/maintenance/i);
        writeFileSync(
          path.join(dir, MAINTENANCE_LOCK_FILE),
          JSON.stringify({ pid: 999_999_999, startedAtIso: "2026-01-01T00:00:00.000Z", purpose: "restore" }),
        );
        expect(() => assertNoMaintenanceExclusion(dir, "open learning.db")).not.toThrow();
      } finally {
        held.release();
      }
      expect(() => assertNoMaintenanceExclusion(dir, "open learning.db")).not.toThrow();
    });
  });

  describe("#19 — the exclusion's stale-unlink race", () => {
    /** A lock file whose holder cannot be running. */
    function deadHolderLock(dir: string): string {
      const file = path.join(dir, MAINTENANCE_LOCK_FILE);
      writeFileSync(
        file,
        JSON.stringify({ pid: 999_999_999, startedAtIso: "2026-01-01T00:00:00.000Z", purpose: "restore" }),
      );
      return file;
    }

    it("refuses instead of reclaiming, and names the file a human must remove", async () => {
      await backupSevenLiveTwelve();
      const lock = deadHolderLock(stradaHome);

      const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
        () => null,
        (err: Error) => err,
      );
      expect(outcome?.message).toContain(lock);
      expect(outcome?.message).toMatch(/remove/i);
      expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
      // A deterministic refusal, not a wall: the named file is the whole fix.
      rmSync(lock, { force: true });
      await restoreRuntimeDatabases({ backupDir: destDir });
      expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(7);
    });

    it("never removes a lock it did not write", () => {
      const dir = path.join(root, "race");
      mkdirSync(dir, { recursive: true });
      const lock = deadHolderLock(dir);
      const before = readFileSync(lock, "utf8");

      // The race: A and B both read the dead holder, A reclaims and writes its
      // own lock, and B's delayed `rmSync` deletes A's LIVE lock — after which B
      // acquires too and two restores swap the same files.
      expect(() => acquireMaintenanceExclusion(dir)).toThrow(/maintenance/i);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(lock, "utf8")).toBe(before);
      expect(() => acquireMaintenanceExclusion(dir)).toThrow(/maintenance/i);
      expect(readFileSync(lock, "utf8")).toBe(before);
    });

    it("does not read an empty lock as corrupt, and never writes a partial one", () => {
      const dir = path.join(root, "empty-lock");
      mkdirSync(dir, { recursive: true });
      const lock = path.join(dir, MAINTENANCE_LOCK_FILE);
      // An EMPTY lock is what another acquirer looks like for the instant
      // between creating the file and writing its payload. Treating it as
      // corrupt/stale removed a live restore's claim.
      writeFileSync(lock, "");
      expect(() => acquireMaintenanceExclusion(dir)).toThrow(/maintenance/i);
      expect(existsSync(lock)).toBe(true);

      rmSync(lock, { force: true });
      const held = acquireMaintenanceExclusion(dir, "restore");
      // Whatever a concurrent reader sees, it is never a half-written claim.
      const payload = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; purpose: string };
      expect(payload.pid).toBe(process.pid);
      expect(payload.purpose).toBe("restore");
      held.release();
      expect(existsSync(lock)).toBe(false);
    });
  });

  describe("#20 — a backup member that is a symlink out of the archive", () => {
    it("refuses, and neither the live database nor the external one is touched", async () => {
      await backupSevenLiveTwelve();
      // A valid database OUTSIDE the backup directory — the bytes an attacker
      // wants installed over the live one.
      const outside = path.join(root, "outside.db");
      seedDatabase(outside, 1).close();

      const member = path.join(destDir, "memory", "memory_ts.db");
      rmSync(member, { force: true });
      symlinkSync(outside, member);
      // The manifest is the attacker's too, so the recorded size is the size of
      // what the link points at: every member check passes.
      const manifestFile = path.join(destDir, BACKUP_MANIFEST_FILE);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        databases: Array<{ backup: string; bytes: number }>;
      };
      manifest.databases[0]!.bytes = statSync(outside).size;
      writeFileSync(manifestFile, JSON.stringify(manifest));

      const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
        () => null,
        (err: Error) => err,
      );
      expect(outcome?.message).toMatch(/symbolic link|symlink|outside the backup directory/i);
      // The repro: the restore followed the link and installed the external
      // database's single row over twelve live ones.
      expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
      expect(countRows(outside)).toBe(1);
      expect(residue(memoryRoot)).toEqual([]);
    });
  });

  describe("#21 — two destinations that are one file", () => {
    /** Is the destination directory case-insensitive? Measured, never assumed. */
    function caseInsensitive(dir: string): boolean {
      const probe = path.join(dir, "case-probe-abc");
      writeFileSync(probe, "");
      try {
        return existsSync(path.join(dir, "CASE-PROBE-ABC"));
      } finally {
        rmSync(probe, { force: true });
      }
    }

    it("refuses a case-aliased pair instead of destroying both copies", async () => {
      if (!caseInsensitive(memoryRoot)) return; // nothing to alias
      await backupSevenLiveTwelve();

      // Two manifest members, two distinct string destinations, ONE file on this
      // filesystem. The duplicate check compares strings, so both pass it.
      const manifestFile = path.join(destDir, BACKUP_MANIFEST_FILE);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        databases: Array<{ root: string; relative: string; source: string; backup: string; bytes: number }>;
      };
      const first = manifest.databases.find((d) => d.relative === "memory.db")!;
      const aliasBackup = path.join("memory", "Memory_ts.db");
      copyFileSync(path.join(destDir, first.backup), path.join(destDir, aliasBackup));
      manifest.databases.push({ ...first, relative: "Memory.db", backup: aliasBackup });
      writeFileSync(manifestFile, JSON.stringify(manifest));

      const outcome = await restoreRuntimeDatabases({ backupDir: destDir }).then(
        () => null,
        (err: Error) => err,
      );
      // The repro: the first swap put the original aside, the second overwrote
      // that aside with the file the first swap had just restored, and then
      // failed on a staged file already consumed — leaving the destination gone.
      expect(existsSync(path.join(memoryRoot, "memory.db"))).toBe(true);
      expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(12);
      expect(outcome?.message).toMatch(/same file|named twice/i);
      expect(residue(memoryRoot)).toEqual([]);
    });

    it("refuses a case-aliased pair whose destination does not exist yet", async () => {
      if (!caseInsensitive(memoryRoot)) return;
      // No inode to collide on — a fresh installation restoring into an empty
      // root — so only the case-folded key can catch this one. Left unchecked,
      // both entries restore and the second silently overwrites the first.
      seedDatabase(path.join(memoryRoot, "memory.db"), 7).close();
      await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
      const manifestFile = path.join(destDir, BACKUP_MANIFEST_FILE);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        databases: Array<{ root: string; relative: string; source: string; backup: string; bytes: number }>;
      };
      const first = manifest.databases.find((d) => d.relative === "memory.db")!;
      const lower = path.join("memory", "fresh_ts.db");
      const upper = path.join("memory", "Fresh_ts.db");
      copyFileSync(path.join(destDir, first.backup), path.join(destDir, lower));
      copyFileSync(path.join(destDir, first.backup), path.join(destDir, upper));
      manifest.databases = [
        { ...first, relative: "fresh.db", backup: lower },
        { ...first, relative: "Fresh.db", backup: upper },
      ];
      writeFileSync(manifestFile, JSON.stringify(manifest));

      await expect(restoreRuntimeDatabases({ backupDir: destDir })).rejects.toThrow(
        /same file on this filesystem/,
      );
      expect(existsSync(path.join(memoryRoot, "fresh.db"))).toBe(false);
      expect(residue(memoryRoot)).toEqual([]);
    });

    it("stages each destination under its own name", async () => {
      // Defensive half: even destinations the equivalence check did not catch
      // must not share a staging file. One stamp, one name per item.
      seedDatabase(path.join(memoryRoot, "memory.db"), 3).close();
      seedDatabase(path.join(stradaHome, "hub-owners.db"), 4).close();
      await backupRuntimeDatabases({ ...defaultInstallation(), destDir, timestamp: "ts" });
      seedDatabase(path.join(memoryRoot, "memory.db"), 30).close();

      const stagedNames: string[] = [];
      await restoreRuntimeDatabases({
        backupDir: destDir,
        onStaged: () => {
          stagedNames.push(
            ...readdirSync(memoryRoot).filter((n) => n.includes(".restore-")),
            ...readdirSync(stradaHome).filter((n) => n.includes(".restore-")),
          );
        },
      });
      expect(stagedNames).toHaveLength(2);
      expect(new Set(stagedNames).size).toBe(2);
      expect(countRows(path.join(memoryRoot, "memory.db"))).toBe(3);
    });
  });
});

/**
 * Codex round 13 #18, the opener side, completed: EVERY store joins the
 * exclusion, not only the one that remembered to ask.
 *
 * `LearningStorage` called `assertNoMaintenanceExclusion` itself, which left the
 * other ~20 stores free to open a database mid-swap — and an opener that arrives
 * between a destination's check and its rename writes to an inode the restore is
 * about to delete, so the restore reports success while the installation is not
 * using restored state. Every store in this system configures its pragmas
 * through one helper, so that is where the question is asked.
 */
describe("every store asks before opening (round 13 #18)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env["STRADA_HOME"];
  });

  function homeWithLock(holderPid: number): string {
    const home = mkdtempSync(path.join(tmpdir(), "strada-exclusion-home-"));
    dirs.push(home);
    writeFileSync(
      path.join(home, "maintenance.lock"),
      `${JSON.stringify({ pid: holderPid, purpose: "restore", startedAtIso: new Date().toISOString() })}\n`,
    );
    process.env["STRADA_HOME"] = home;
    return home;
  }

  it("refuses to configure a database while a LIVE maintenance holder is swapping", async () => {
    homeWithLock(process.pid);
    const { configureSqlitePragmas } = await import("../memory/unified/sqlite-pragmas.js");
    const dbDir = mkdtempSync(path.join(tmpdir(), "strada-exclusion-db-"));
    dirs.push(dbDir);
    const db = new Database(path.join(dbDir, "memory.db"));
    try {
      expect(() => configureSqlitePragmas(db, "memory")).toThrow(/maintenance operation/i);
    } finally {
      db.close();
    }
  });

  it("a refused open deletes nothing, because it cannot vouch for the pathname", async () => {
    // Round 14 unlinked a still-empty file here; round 15 #7 showed the race:
    // between the size check and the unlink, the restore can rename a POPULATED
    // database onto that pathname, and the cleanup then deletes restored data.
    // Same lesson as the `.env` recovery mutex — never remove a pathname on the
    // strength of an earlier observation. An empty file left behind is harmless:
    // the restore replaces every destination it owns.
    homeWithLock(process.pid);
    const { configureSqlitePragmas } = await import("../memory/unified/sqlite-pragmas.js");
    const dbDir = mkdtempSync(path.join(tmpdir(), "strada-exclusion-empty-"));
    dirs.push(dbDir);
    const file = path.join(dbDir, "memory.db");
    const db = new Database(file);
    try {
      expect(() => configureSqlitePragmas(db, "memory")).toThrow(/maintenance operation/i);
    } finally {
      db.close();
    }
    // The file the OPEN created is still there — and that is the safe answer.
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBe(0);
  });

  it("a store that wants no file created asks BEFORE it opens", async () => {
    // That is the only place the question can be answered without creating
    // anything, and it is what LearningStorage.initialize does.
    const home = homeWithLock(process.pid);
    const { LearningStorage } = await import("../learning/storage/learning-storage.js");
    const dbDir = mkdtempSync(path.join(tmpdir(), "strada-exclusion-early-"));
    dirs.push(dbDir);
    const file = path.join(dbDir, "learning.db");
    const storage = new LearningStorage(file);
    expect(() => storage.initialize()).toThrow(/maintenance operation/i);
    expect(existsSync(file)).toBe(false);
    expect(home).toBeTruthy();
  });

  it("a refused open never removes a database that has content (guard)", async () => {
    homeWithLock(process.pid);
    const { configureSqlitePragmas } = await import("../memory/unified/sqlite-pragmas.js");
    const dbDir = mkdtempSync(path.join(tmpdir(), "strada-exclusion-keep-"));
    dirs.push(dbDir);
    const file = path.join(dbDir, "memory.db");
    // Somebody's data: one table, one row, written before the maintenance window.
    const seed = new Database(file);
    seed.exec("CREATE TABLE kept (id INTEGER PRIMARY KEY)");
    seed.prepare("INSERT INTO kept VALUES (1)").run();
    seed.close();
    const before = statSync(file).size;
    expect(before).toBeGreaterThan(0);

    const db = new Database(file);
    expect(() => configureSqlitePragmas(db, "memory")).toThrow(/maintenance operation/i);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBe(before);
    const reopened = new Database(file, { readonly: true });
    try {
      expect((reopened.prepare("SELECT COUNT(*) AS n FROM kept").get()).n).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("a lock left by a DEAD holder never keeps the daemon out of its own store (guard)", async () => {
    homeWithLock(0x7ffffffe);
    const { configureSqlitePragmas } = await import("../memory/unified/sqlite-pragmas.js");
    const Database = (await import("better-sqlite3")).default;
    const dbDir = mkdtempSync(path.join(tmpdir(), "strada-exclusion-db2-"));
    dirs.push(dbDir);
    const db = new Database(path.join(dbDir, "memory.db"));
    try {
      expect(() => configureSqlitePragmas(db, "memory")).not.toThrow();
    } finally {
      db.close();
    }
  });
});
