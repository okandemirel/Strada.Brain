import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { backupRuntimeDatabases } from "../../core/database-backup.js";

/**
 * `scripts/restore.mjs` (plan 6.13).
 *
 * `restoreRuntimeDatabases()` existed with tests and NOTHING drove it: the
 * restore had never been executed by anything an operator could run. These cases
 * drive the script itself — a real backup of real SQLite databases, data lost,
 * the script run as a child process, rows compared back — plus the two honest
 * reporting rules it has to hold: a copy with no `.sha256` sidecar is reported as
 * NOT VERIFIED rather than verified, and a copy whose bytes disagree with its
 * sidecar is refused before a live database is touched.
 */
const RESTORE_SCRIPT = path.join(process.cwd(), "scripts", "restore.mjs");

interface RestoreModule {
  parseRestoreArgs: (argv: string[]) => {
    archive?: string;
    backupDir?: string;
    dryRun: boolean;
    skipChecksums: boolean;
    roots: Record<string, string>;
  };
  findManifestDir: (root: string) => string | null;
  verifyBackupChecksums: (
    backupDir: string,
    manifest: { databases: Array<{ backup: string }> },
  ) => Array<{ backup: string; state: string }>;
  verifyChecksumSidecar: (file: string, label?: string) => { backup: string; state: string };
}

const restore = (await import(pathToFileURL(RESTORE_SCRIPT).href)) as RestoreModule;

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function seed(file: string, rows: Array<[number, string]>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS rows_under_test (id INTEGER PRIMARY KEY, payload TEXT)");
    const insert = db.prepare("INSERT INTO rows_under_test (id, payload) VALUES (?, ?)");
    for (const [id, payload] of rows) insert.run(id, payload);
  } finally {
    db.close();
  }
}

function read(file: string): Array<{ id: number; payload: string }> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, payload FROM rows_under_test ORDER BY id").all() as Array<{
      id: number;
      payload: string;
    }>;
  } finally {
    db.close();
  }
}

function runRestore(args: string[]): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [RESTORE_SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("scripts/restore.mjs", () => {
  const dirs: string[] = [];

  function tempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-restore-test-"));
    dirs.push(dir);
    return dir;
  }

  /** A temporary installation plus a backup of it, with sidecars like backup.sh writes. */
  async function installationWithBackup(options: { sidecars: boolean } = { sidecars: true }) {
    const root = tempRoot();
    const memoryRoot = path.join(root, "memory");
    const stradaHome = path.join(root, "strada-home");
    const backupDir = path.join(root, "backup");
    const memoryDb = path.join(memoryRoot, "memory.db");
    const campaignsDb = path.join(memoryRoot, "campaigns.db");
    const hubOwnersDb = path.join(stradaHome, "hub-owners.db");

    seed(memoryDb, [[1, "campaign state"], [2, "learned lesson"]]);
    seed(campaignsDb, [[1, "sprint ladder"]]);
    seed(hubOwnersDb, [[1, "chat binding"]]);

    const produced = await backupRuntimeDatabases({
      memoryRoot,
      stradaHome,
      // Keep the operator's real ~/.strada out of an inventory that a restore
      // would later write back to.
      userHome: path.join(root, "fake-home"),
      destDir: backupDir,
    });
    if (options.sidecars) {
      // backup.sh writes a sidecar for every file the helper PRINTS, and the
      // manifest is one of them — so the fixture writes that one too, or the
      // manifest verification round 12 #19 added would have nothing to read.
      const manifestFile = path.join(backupDir, "databases.manifest.json");
      for (const copy of [...produced.map((c) => c.destination), manifestFile]) {
        fs.writeFileSync(`${copy}.sha256`, `${sha256(copy)}  ${path.basename(copy)}\n`);
      }
    }
    return { root, memoryRoot, stradaHome, backupDir, memoryDb, campaignsDb, hubOwnersDb, produced };
  }

  /** The tar.gz backup.sh produces: a `backup_<timestamp>/` directory inside it. */
  async function makeArchive(fixture: { root: string; backupDir: string }): Promise<string> {
    const archiveDir = path.join(fixture.root, "archive-src", "backup_20260918_000000");
    fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
    fs.cpSync(fixture.backupDir, archiveDir, { recursive: true });
    const archive = path.join(fixture.root, "backup_20260918_000000.tar.gz");
    spawnSync("tar", ["-czf", archive, "-C", path.dirname(archiveDir), path.basename(archiveDir)], {
      encoding: "utf8",
    });
    expect(fs.existsSync(archive)).toBe(true);
    return archive;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores deleted rows and a deleted database file, and verifies the checksums", async () => {
    const fixture = await installationWithBackup();
    const before = read(fixture.memoryDb);

    const live = new Database(fixture.memoryDb);
    live.exec("DELETE FROM rows_under_test");
    live.close();
    fs.rmSync(fixture.campaignsDb, { force: true });
    expect(read(fixture.memoryDb)).toHaveLength(0);
    expect(fs.existsSync(fixture.campaignsDb)).toBe(false);

    const { code, output } = runRestore(["--backup-dir", fixture.backupDir]);

    expect(output).toContain("copies checksum-verified");
    expect(code).toBe(0);
    expect(read(fixture.memoryDb)).toEqual(before);
    expect(fs.existsSync(fixture.campaignsDb)).toBe(true);
    expect(read(fixture.campaignsDb)).toEqual([{ id: 1, payload: "sprint ladder" }]);
    // Each restored file is self-contained: a stale -wal would replay over it.
    expect(fs.existsSync(`${fixture.memoryDb}-wal`)).toBe(false);
  });

  it("refuses a tampered copy instead of overwriting a live database", async () => {
    const fixture = await installationWithBackup();
    const victim = fixture.produced[0]!.destination;
    fs.writeFileSync(victim, "corrupted bytes");
    const liveBefore = read(fixture.memoryDb);

    const { code, output } = runRestore(["--backup-dir", fixture.backupDir]);

    expect(code).toBe(1);
    expect(output).toContain("refusing to overwrite live databases");
    expect(output).toContain("MISMATCH");
    // The point of verifying before writing: nothing was touched.
    expect(read(fixture.memoryDb)).toEqual(liveBefore);
  });

  it("reports a copy with no sidecar as NOT VERIFIED rather than verified", async () => {
    const fixture = await installationWithBackup({ sidecars: false });

    const { code, output } = runRestore(["--backup-dir", fixture.backupDir]);

    expect(code).toBe(0);
    expect(output).toContain("NOT VERIFIED (no .sha256 sidecar)");
    expect(output).toContain("had no sidecar to verify against");
    expect(output).not.toMatch(/\d+\/\d+ copies checksum-verified; 0 had no sidecar/u);
  });

  it("restores into redirected roots when asked, leaving the recorded paths alone", async () => {
    const fixture = await installationWithBackup();
    const elsewhere = path.join(fixture.root, "elsewhere");
    fs.rmSync(fixture.memoryDb, { force: true });

    const { code, output } = runRestore([
      "--backup-dir", fixture.backupDir,
      "--memory-root", elsewhere,
    ]);

    expect(code).toBe(0);
    expect(output).toContain(elsewhere);
    expect(fs.existsSync(path.join(elsewhere, "memory.db"))).toBe(true);
    expect(read(path.join(elsewhere, "memory.db"))).toHaveLength(2);
    // The redirected root was used, so the original location stays missing.
    expect(fs.existsSync(fixture.memoryDb)).toBe(false);
  });

  it("--dry-run prints the plan and writes nothing", async () => {
    const fixture = await installationWithBackup();
    fs.rmSync(fixture.campaignsDb, { force: true });

    const { code, output } = runRestore(["--backup-dir", fixture.backupDir, "--dry-run"]);

    expect(code).toBe(0);
    expect(output).toContain("nothing was written");
    expect(fs.existsSync(fixture.campaignsDb)).toBe(false);
  });

  it("restores from the tar.gz archive backup.sh produces, manifest one level down", async () => {
    const fixture = await installationWithBackup();
    // backup.sh archives a backup_<timestamp>/ directory, so the manifest sits
    // one level inside the tarball — the shape restore.mjs has to accept.
    const archiveDir = path.join(fixture.root, "archive-src", "backup_20260918_000000");
    fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
    fs.cpSync(fixture.backupDir, archiveDir, { recursive: true });
    const archive = path.join(fixture.root, "backup_20260918_000000.tar.gz");
    spawnSync("tar", ["-czf", archive, "-C", path.dirname(archiveDir), path.basename(archiveDir)], {
      encoding: "utf8",
    });
    expect(fs.existsSync(archive)).toBe(true);

    const live = new Database(fixture.memoryDb);
    live.exec("DELETE FROM rows_under_test");
    live.close();

    const { code, output } = runRestore(["--archive", archive]);

    expect(code).toBe(0);
    expect(output).toContain("extracted");
    expect(read(fixture.memoryDb)).toHaveLength(2);
  });

  it("exits 2 on arguments that name nothing to restore from", () => {
    expect(runRestore([]).code).toBe(2);
    expect(runRestore(["--archive", "/nope/missing.tar.gz"]).code).toBe(2);
    expect(runRestore(["--backup-dir", os.tmpdir()]).code).toBe(2);
  });

  it("parses flags, refuses both sources at once, and finds the manifest either way", async () => {
    const parsed = restore.parseRestoreArgs([
      "--backup-dir", "/tmp/b", "--memory-root", "/tmp/m", "--dry-run", "--skip-checksums",
    ]);
    expect(parsed.backupDir).toBe("/tmp/b");
    expect(parsed.roots["memory"]).toBe(path.resolve("/tmp/m"));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.skipChecksums).toBe(true);
    expect(() => restore.parseRestoreArgs(["--archive", "a", "--backup-dir", "b"])).toThrow(/not both/u);
    expect(() => restore.parseRestoreArgs([])).toThrow(/usage/u);

    const fixture = await installationWithBackup();
    expect(restore.findManifestDir(fixture.backupDir)).toBe(fixture.backupDir);
    expect(restore.findManifestDir(path.dirname(fixture.backupDir))).toBe(fixture.backupDir);
    expect(restore.findManifestDir(fixture.memoryRoot)).toBeNull();
  });

  /**
   * ROUND 12 #19 — the manifest is the file that decides where every byte goes.
   *
   * Its own `.sha256` sidecar (which backup.sh writes for it, because the helper
   * prints it like every other produced file) was never read. The tamper here is
   * deliberately one that NOTHING else can catch: a redirected `roots` entry is a
   * perfectly well-formed manifest, every member's bytes are untouched, so every
   * member checksum passes — and the restore writes the memory databases into a
   * directory the operator never named.
   */
  it("refuses a manifest whose own sidecar disagrees, before touching a database", async () => {
    const fixture = await installationWithBackup();
    const manifestFile = path.join(fixture.backupDir, "databases.manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      roots: Record<string, string>;
    };
    const victimRoot = path.join(fixture.root, "somewhere-else");
    const victim = path.join(victimRoot, "memory.db");
    fs.mkdirSync(victimRoot, { recursive: true });
    fs.writeFileSync(victim, "a file of the operator's that is not a backup destination\n");
    const victimBytes = fs.readFileSync(victim);
    manifest.roots["memory"] = victimRoot;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const liveBefore = read(fixture.memoryDb);

    const { code, output } = runRestore(["--backup-dir", fixture.backupDir]);

    // The BYTES first, because they are the finding: the redirected destination
    // was not written and the real one was not restored over either.
    expect(fs.readFileSync(victim)).toEqual(victimBytes);
    expect(read(fixture.memoryDb)).toEqual(liveBefore);
    expect(code).toBe(1);
    expect(output).toContain("databases.manifest.json: MISMATCH");
    expect(output).toContain("refusing to overwrite live databases");
  });

  it("refuses an archive whose own sidecar disagrees, before unpacking it", async () => {
    const fixture = await installationWithBackup();
    const archive = await makeArchive(fixture);
    // What backup.sh writes beside the archive — with the digest of a DIFFERENT
    // archive, which is what a truncated or swapped transfer leaves behind.
    fs.writeFileSync(`${archive}.sha256`, `${"0".repeat(64)}  ${path.basename(archive)}\n`);
    const live = new Database(fixture.memoryDb);
    live.exec("DELETE FROM rows_under_test");
    live.close();

    const { code, output } = runRestore(["--archive", archive]);

    expect(code).toBe(1);
    expect(output).toMatch(/refusing to restore/u);
    expect(output).not.toContain("extracted");
    // Refused, so the rows it would have restored are still missing.
    expect(read(fixture.memoryDb)).toHaveLength(0);
  });

  it("reports an archive with no sidecar as NOT VERIFIED rather than verified", async () => {
    const fixture = await installationWithBackup();
    const archive = await makeArchive(fixture);

    const { code, output } = runRestore(["--archive", archive]);

    expect(code).toBe(0);
    expect(output).toContain("NOT VERIFIED (no .sha256 sidecar)");
  });

  /**
   * ROUND 12 #22 — a restore renames databases out from under their users.
   *
   * Driven through the CLI, because that is what an operator runs: the refusal
   * has to reach them as a non-zero exit with the live rows still in place, and
   * the override has to exist for the case where they know better.
   */
  it("refuses while a database still has a user attached, and says how to proceed", async () => {
    const fixture = await installationWithBackup();
    const live = new Database(fixture.memoryDb);
    live.pragma("journal_mode = WAL");
    live.exec("DELETE FROM rows_under_test");
    live.prepare("INSERT INTO rows_under_test (id, payload) VALUES (7, ?)").run("written while open");
    try {
      const refused = runRestore(["--backup-dir", fixture.backupDir]);

      // The rows the attached connection committed are still what the file holds.
      expect(read(fixture.memoryDb)).toEqual([{ id: 7, payload: "written while open" }]);
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(/still have a user attached/u);
      expect(refused.output).toMatch(/strada kill/u);

      // The override exists and is announced, because it is the operator taking
      // the risk the refusal exists to describe.
      const forced = runRestore(["--backup-dir", fixture.backupDir, "--allow-attached-users"]);
      expect(forced.output).toMatch(/--allow-attached-users/u);
      expect(forced.code).toBe(0);
      expect(read(fixture.memoryDb)).toHaveLength(2);
    } finally {
      live.close();
    }
  });

  /**
   * ROUND 12 #23 — project data could not be redirected through the CLI.
   *
   * `delivery-packages.db` lives in `<projectRoot>/.strada`, and with every
   * offered override given the restore still wrote it back to the absolute
   * project directory of the machine the backup came from.
   */
  it("redirects the project root, so a project database lands on THIS machine", async () => {
    const root = tempRoot();
    const memoryRoot = path.join(root, "memory");
    const stradaHome = path.join(root, "strada-home");
    const originalProject = path.join(root, "original-project");
    const backupDir = path.join(root, "backup");
    const originalPackages = path.join(originalProject, ".strada", "delivery-packages.db");
    seed(path.join(memoryRoot, "memory.db"), [[1, "campaign state"]]);
    seed(originalPackages, [[1, "delivery revision"]]);

    const produced = await backupRuntimeDatabases({
      memoryRoot,
      stradaHome,
      userHome: path.join(root, "fake-home"),
      projectRoot: originalProject,
      destDir: backupDir,
    });
    for (const copy of [
      ...produced.map((c) => c.destination),
      path.join(backupDir, "databases.manifest.json"),
    ]) {
      fs.writeFileSync(`${copy}.sha256`, `${sha256(copy)}  ${path.basename(copy)}\n`);
    }
    // The machine the restore is happening ON: the original project directory is
    // not where this operator keeps the project.
    fs.rmSync(originalProject, { recursive: true, force: true });
    const newProject = path.join(root, "this-machine-project");
    const newMemory = path.join(root, "this-machine-memory");

    const { code, output } = runRestore([
      "--backup-dir", backupDir,
      "--memory-root", newMemory,
      "--project-root", newProject,
    ]);

    expect(code).toBe(0);
    expect(output).toContain(newProject);
    const restored = path.join(newProject, ".strada", "delivery-packages.db");
    expect(fs.existsSync(restored)).toBe(true);
    expect(read(restored)).toEqual([{ id: 1, payload: "delivery revision" }]);
    // And nothing was written back to the absolute path the backup came from.
    expect(fs.existsSync(originalPackages)).toBe(false);
  });

  it("classifies each copy as verified / mismatch / no-sidecar", async () => {
    const fixture = await installationWithBackup();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture.backupDir, "databases.manifest.json"), "utf8"),
    ) as { databases: Array<{ backup: string }> };

    fs.rmSync(`${fixture.produced[1]!.destination}.sha256`, { force: true });
    fs.writeFileSync(fixture.produced[0]!.destination, "corrupted");
    const rows = restore.verifyBackupChecksums(fixture.backupDir, manifest);

    expect(rows.find((row) => row.backup === manifest.databases[0]!.backup)?.state).toBe("mismatch");
    expect(rows.find((row) => row.backup === manifest.databases[1]!.backup)?.state).toBe("no-sidecar");
    expect(rows.filter((row) => row.state === "verified").length).toBe(rows.length - 2);
  });
});

/**
 * `scripts/backup.sh` on a backup directory that does not exist yet (plan 6.13).
 *
 * Found by the release acceptance runner rather than by reading: `log()` writes
 * into `$BACKUP_DIR/backup.log` and `main()` logs three lines before `setup()`
 * creates that directory, so on a clean install — or the first scheduled run, or
 * a new volume — `tee` failed, pipefail turned it into a non-zero pipeline and
 * `set -e` ended the backup with nothing copied and a single `tee:` line as the
 * only evidence. The first backup a machine ever takes is exactly the one an
 * operator is relying on.
 */
describe("scripts/backup.sh", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up into a BACKUP_DIR that does not exist yet", () => {
    const cli = path.join(process.cwd(), "dist", "core", "database-backup.js");
    // The script shells out to the compiled helper; without it there is nothing
    // to measure, and saying so beats a green test that checked nothing. It
    // FAILS rather than skips: CI's verify job runs `npm run build` before
    // `npm test` so this can hold, and a skip would hide a reordered workflow.
    expect(
      fs.existsSync(cli),
      `${cli} is missing: run \`npm run build\` before this test (scripts/backup.sh runs the compiled ` +
        "helper from dist/; in CI the verify job's Build step must come before Test)",
    ).toBe(true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "strada-backup-sh-"));
    dirs.push(root);
    const home = path.join(root, "home");
    const stradaHome = path.join(home, ".strada");
    const memoryRoot = path.join(stradaHome, "memory");
    const backupDir = path.join(root, "not", "created", "yet");
    seed(path.join(memoryRoot, "memory.db"), [[1, "row that must survive"]]);

    const result = spawnSync("bash", [path.join(process.cwd(), "scripts", "backup.sh")], {
      encoding: "utf8",
      cwd: process.cwd(),
      timeout: 180_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        STRADA_HOME: stradaHome,
        MEMORY_DB_PATH: memoryRoot,
        BACKUP_DIR: backupDir,
        RCLONE_REMOTE: "",
        AWS_S3_BUCKET: "",
        DISCORD_WEBHOOK_URL: "",
        SLACK_WEBHOOK_URL: "",
      },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(output).not.toContain("No such file or directory");
    expect(result.status, output.slice(-1500)).toBe(0);
    const archives = fs.readdirSync(backupDir).filter((name) => name.endsWith(".tar.gz"));
    expect(archives).toHaveLength(1);
    expect(fs.existsSync(path.join(backupDir, `${archives[0]}.sha256`))).toBe(true);
  });
});
