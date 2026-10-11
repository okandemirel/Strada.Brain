/**
 * scripts/backup.sh retention, run end to end (OPS-9).
 *
 * `((deleted++))` evaluates to the counter's OLD value, so with deleted=0 its
 * exit status is 1 and `set -e` killed the script right after deleting the
 * first expired archive — before remote sync and the success notification.
 * From day RETENTION_DAYS+1 on, every scheduled run failed and off-site copies
 * silently stopped. The KEEP_COUNT branch had the same increment.
 *
 * The run needs no build: STRADA_INSTALL_ROOT points at a throwaway install
 * whose database helper finds nothing (and says so with its receipt, the
 * manifest), and `rclone` and `curl` are stubs that record what they were
 * asked to do.
 *
 * backup-receipt: the script also archived a helper that printed nothing as
 * "No databases found", never told the webhook about a failed run, and sent
 * "Backup completed" while the off-site copy it was configured to make was
 * skipped because its tool was missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DAY_MS = 24 * 60 * 60 * 1000;

const roots: string[] = [];

const EMPTY_HELPER = `
const dest = process.argv[process.argv.indexOf("--dest") + 1];
Promise.all([import("node:fs"), import("node:path")]).then(([fs, path]) => {
  const manifest = path.join(dest, "databases.manifest.json");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, roots: {}, databases: [], blobs: [] }) + "\\n");
  process.stdout.write(manifest + "\\n");
});
`;

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "strada-backup-sh-"));
  roots.push(root);
  const installRoot = path.join(root, "install");
  mkdirSync(path.join(installRoot, "dist", "core"), { recursive: true });
  // The database helper: nothing to back up, and its receipt says so — the
  // manifest it wrote, printed last, as the real one does.
  writeFileSync(path.join(installRoot, "dist", "core", "database-backup.js"), EMPTY_HELPER, "utf8");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const rcloneLog = path.join(root, "rclone.log");
  writeFileSync(path.join(bin, "rclone"), `#!/bin/sh\necho "$*" >> "${rcloneLog}"\n`, { encoding: "utf8", mode: 0o755 });
  const curlLog = path.join(root, "curl.log");
  writeFileSync(path.join(bin, "curl"), `#!/bin/sh\necho "$*" >> "${curlLog}"\n`, { encoding: "utf8", mode: 0o755 });
  const backupDir = path.join(root, "backups");
  mkdirSync(backupDir);
  const work = path.join(root, "work");
  mkdirSync(work);
  return { root, installRoot, bin, rcloneLog, curlLog, backupDir, work };
}

function webhookCalls(fixture: ReturnType<typeof makeFixture>): string {
  return existsSync(fixture.curlLog) ? readFileSync(fixture.curlLog, "utf8") : "";
}

function archives(backupDir: string): string[] {
  return readdirSync(backupDir).filter((f) => /^backup_.*\.tar\.gz$/.test(f));
}

function seedArchive(backupDir: string, name: string, ageDays: number): string {
  const archive = path.join(backupDir, `${name}.tar.gz`);
  writeFileSync(archive, "old", "utf8");
  writeFileSync(`${archive}.sha256`, "0  old", "utf8");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(archive, when, when);
  utimesSync(`${archive}.sha256`, when, when);
  return archive;
}

function runBackup(fixture: ReturnType<typeof makeFixture>, env: Record<string, string>) {
  const result = spawnSync("bash", [path.join(repoRoot, "scripts", "backup.sh")], {
    cwd: fixture.work,
    env: {
      ...process.env,
      PATH: `${fixture.bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      STRADA_INSTALL_ROOT: fixture.installRoot,
      BACKUP_DIR: fixture.backupDir,
      MEMORY_DB_PATH: path.join(fixture.root, "no-memory"),
      STRADA_HOME: path.join(fixture.root, "strada-home"),
      RCLONE_REMOTE: "offsite:strada",
      AWS_S3_BUCKET: "",
      DISCORD_WEBHOOK_URL: "",
      SLACK_WEBHOOK_URL: "https://hooks.invalid/backup",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("scripts/backup.sh retention", () => {
  it("deletes every expired archive and still reaches remote sync", () => {
    const fixture = makeFixture();
    const expired = [seedArchive(fixture.backupDir, "backup_20000101_000000", 40), seedArchive(fixture.backupDir, "backup_20000102_000000", 39)];
    const { status, output } = runBackup(fixture, { RETENTION_DAYS: "30" });
    expect(status, output).toBe(0);
    for (const archive of expired) {
      expect(existsSync(archive), archive).toBe(false);
      expect(existsSync(`${archive}.sha256`)).toBe(false);
    }
    expect(output).toContain("Deleted 2 old backup(s)");
    expect(readFileSync(fixture.rcloneLog, "utf8")).toContain(`sync ${fixture.backupDir} offsite:strada`);
    // Today's archive was written and kept.
    expect(readdirSync(fixture.backupDir).filter((f) => /^backup_.*\.tar\.gz$/.test(f))).toHaveLength(1);
  });

  it("keeps only the newest KEEP_COUNT archives and exits 0", () => {
    const fixture = makeFixture();
    const older = [seedArchive(fixture.backupDir, "backup_20240101_000000", 3), seedArchive(fixture.backupDir, "backup_20240102_000000", 2)];
    const { status, output } = runBackup(fixture, { RETENTION_DAYS: "30", KEEP_COUNT: "1" });
    expect(status, output).toBe(0);
    for (const archive of older) expect(existsSync(archive), archive).toBe(false);
    expect(readdirSync(fixture.backupDir).filter((f) => /^backup_.*\.tar\.gz$/.test(f))).toHaveLength(1);
    expect(readFileSync(fixture.rcloneLog, "utf8")).toContain("sync");
  });
});

describe.skipIf(process.platform === "win32")("scripts/backup.sh says when it did not back up (backup-receipt)", () => {
  it("fails when the database helper exits 0 without its receipt", () => {
    // A helper whose main() never ran (an entry guard that did not match, a
    // stub left by a broken build) prints nothing and exits 0. That was read
    // as "No databases found" and archived as a good backup.
    const fixture = makeFixture();
    writeFileSync(path.join(fixture.installRoot, "dist", "core", "database-backup.js"), "", "utf8");
    const { status, output } = runBackup(fixture, {});
    expect(status, output).not.toBe(0);
    expect(output).toMatch(/without its receipt/);
    expect(output).not.toMatch(/No databases found/);
    expect(output).not.toMatch(/Backup completed/);
    expect(archives(fixture.backupDir)).toEqual([]);
  });

  it("accepts the helper's explicit empty receipt as a backup of nothing", () => {
    const fixture = makeFixture();
    const { status, output } = runBackup(fixture, {});
    expect(status, output).toBe(0);
    expect(output).toMatch(/No databases found/);
    expect(webhookCalls(fixture)).toMatch(/Backup success/);
  });

  it("recognises the receipt however BACKUP_DIR is spelled", () => {
    // The helper prints a normalised path; a trailing slash makes the script's
    // own spelling `<dir>//backup_…`, which is the same file and not the same string.
    const fixture = makeFixture();
    const { status, output } = runBackup(fixture, { BACKUP_DIR: `${fixture.backupDir}/` });
    expect(status, output).toBe(0);
    expect(archives(fixture.backupDir)).toHaveLength(1);
  });

  it("tells the webhook when a run fails", () => {
    const fixture = makeFixture();
    rmSync(path.join(fixture.installRoot, "dist", "core", "database-backup.js"));
    const { status, output } = runBackup(fixture, {});
    expect(status, output).not.toBe(0);
    const calls = webhookCalls(fixture);
    expect(calls, output).toMatch(/Backup failure/);
    expect(calls).toMatch(/Database backup helper missing/);
    expect(calls).not.toMatch(/Backup success/);
  });

  it("tells the webhook even when the backup directory itself cannot be written", () => {
    // The log lives in BACKUP_DIR, so the failure report's own log line fails
    // too; that must not swallow the notification.
    const fixture = makeFixture();
    const blocker = path.join(fixture.root, "not-a-directory");
    writeFileSync(blocker, "", "utf8");
    const { status, output } = runBackup(fixture, { BACKUP_DIR: path.join(blocker, "backups") });
    expect(status, output).not.toBe(0);
    expect(webhookCalls(fixture), output).toMatch(/Backup failure/);
  });

  it("fails instead of reporting success when a configured off-site copy was skipped", () => {
    // RCLONE_REMOTE is set and rclone is not installed (a rebuilt host): the
    // off-site copy the operator configured did not happen, and every run
    // still said "Backup completed".
    const fixture = makeFixture();
    const bare = path.join(fixture.root, "bare-bin");
    mkdirSync(bare);
    symlinkSync(process.execPath, path.join(bare, "node"));
    symlinkSync(path.join(fixture.bin, "curl"), path.join(bare, "curl"));
    // /usr/bin/git on macOS can be the Xcode licence shim; `version` falls back.
    writeFileSync(path.join(bare, "git"), "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    const { status, output } = runBackup(fixture, {
      PATH: [bare, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
    });
    expect(status, output).not.toBe(0);
    expect(output).toMatch(/rclone is not installed/);
    expect(output).not.toMatch(/Backup completed/);
    const calls = webhookCalls(fixture);
    expect(calls, output).toMatch(/Backup failure/);
    expect(calls).toMatch(/offsite:strada/);
    expect(calls).not.toMatch(/Backup success/);
    // The local archive was made and verified; only the off-site copy is missing.
    expect(archives(fixture.backupDir)).toHaveLength(1);
  });
});
