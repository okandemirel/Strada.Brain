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
 * whose database helper finds nothing, and `rclone` is a stub that records the
 * sync it was asked for.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DAY_MS = 24 * 60 * 60 * 1000;

const roots: string[] = [];

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "strada-backup-sh-"));
  roots.push(root);
  const installRoot = path.join(root, "install");
  mkdirSync(path.join(installRoot, "dist", "core"), { recursive: true });
  // The database helper: nothing to back up.
  writeFileSync(path.join(installRoot, "dist", "core", "database-backup.js"), "", "utf8");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const rcloneLog = path.join(root, "rclone.log");
  writeFileSync(path.join(bin, "rclone"), `#!/bin/sh\necho "$*" >> "${rcloneLog}"\n`, { encoding: "utf8", mode: 0o755 });
  const backupDir = path.join(root, "backups");
  mkdirSync(backupDir);
  const work = path.join(root, "work");
  mkdirSync(work);
  return { root, installRoot, bin, rcloneLog, backupDir, work };
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
