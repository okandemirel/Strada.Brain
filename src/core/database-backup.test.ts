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
  BACKUP_MANIFEST_FILE,
  MEMORY_DATABASE_FILES,
  RUNTIME_DATABASE_FILES,
  STRADA_HOME_DATABASE_FILES,
  backupRuntimeDatabases,
  backupSqliteDatabase,
  inventoryRuntimeDatabases,
  listRuntimeDatabases,
  parseBackupArgs,
  readBackupManifest,
  restoreRuntimeDatabases,
  runBackupCli,
  runtimeDatabaseRoots,
} from "./database-backup.js";
import { HubOwnerStore } from "../channels/hub/owner-store.js";
import { openSkillTrustStore } from "../skills/skill-trust.js";

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
