#!/usr/bin/env node
/**
 * Database restore (plan 6.13).
 *
 * `scripts/backup.sh` has produced archives for a while and
 * `src/core/database-backup.ts` grew a real `restoreRuntimeDatabases()` with
 * tests — but NOTHING drove it. A backup whose restore has never been executed
 * is not a backup; it is a directory of files with an untested claim attached.
 * This is that driver, and the release acceptance runner
 * (`scripts/ci/release-acceptance.mjs`) calls it so the restore is exercised on
 * every acceptance run rather than on the day it is needed.
 *
 * It accepts either half of what backup.sh leaves behind:
 *
 *   node scripts/restore.mjs --archive /backups/strada-brain/backup_20260918_120000.tar.gz
 *   node scripts/restore.mjs --backup-dir /backups/strada-brain/backup_20260918_120000
 *
 * Databases go back to the absolute paths the backup's own
 * `databases.manifest.json` recorded — that is what the manifest exists for —
 * unless a root is redirected:
 *
 *   --memory-root <dir>    where the `memory` root is restored to
 *   --strada-home <dir>    where the `strada-home` root is restored to
 *   --user-home <dir>      where the `user-home` root is restored to
 *   --dry-run              print the plan, touch nothing
 *   --skip-checksums       do not verify the .sha256 sidecars backup.sh wrote
 *
 * Checksums are verified BEFORE anything is overwritten, and a file with no
 * sidecar is reported as `not verified` rather than as verified — restoring a
 * silently-corrupt copy over a live database is the one failure mode a restore
 * must not have.
 *
 * Exit codes: 0 restored (or planned, with --dry-run); 1 the restore failed;
 * 2 bad arguments or nothing to restore from.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** Parse argv. Exported so the flag contract is testable without spawning. */
export function parseRestoreArgs(argv) {
  const flags = { dryRun: false, skipChecksums: false, roots: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") { flags.dryRun = true; continue; }
    if (arg === "--skip-checksums") { flags.skipChecksums = true; continue; }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[i + 1];
    if (value === undefined || (eq < 0 && String(value).startsWith("--"))) {
      throw new Error(`Missing value for --${name}`);
    }
    if (eq < 0) i += 1;
    switch (name) {
      case "archive": flags.archive = value; break;
      case "backup-dir": flags.backupDir = value; break;
      // Root labels come from database-backup.ts: memory / strada-home / user-home.
      case "memory-root": flags.roots["memory"] = path.resolve(value); break;
      case "strada-home": flags.roots["strada-home"] = path.resolve(value); break;
      case "user-home": flags.roots["user-home"] = path.resolve(value); break;
      default: throw new Error(`Unknown flag --${name}`);
    }
  }
  if (!flags.archive && !flags.backupDir) {
    throw new Error("usage: restore.mjs (--archive <tar.gz> | --backup-dir <dir>) [--memory-root <dir>] [--strada-home <dir>] [--user-home <dir>] [--dry-run] [--skip-checksums]");
  }
  if (flags.archive && flags.backupDir) {
    throw new Error("Pass --archive or --backup-dir, not both");
  }
  return flags;
}

/**
 * The directory holding `databases.manifest.json`.
 *
 * backup.sh archives a `backup_<timestamp>/` directory, so an extracted archive
 * has the manifest one level down; a directory passed straight in has it at the
 * top. Searching one level deep covers both without guessing.
 */
export function findManifestDir(root, manifestFile = "databases.manifest.json") {
  if (existsSync(path.join(root, manifestFile))) return root;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (existsSync(path.join(candidate, manifestFile))) return candidate;
  }
  return null;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Verify every `<file>.sha256` sidecar backup.sh wrote.
 *
 * Returns one row per database: `verified`, `mismatch`, or `no-sidecar`.
 * `no-sidecar` is NOT a pass — the caller prints it as "not verified", because a
 * backup produced by something other than backup.sh has no sidecars at all and
 * pretending otherwise is the false green this project keeps finding.
 */
export function verifyBackupChecksums(backupDir, manifest) {
  // Blobs are optional in the manifest (a backup taken before retained
  // attachment bytes existed has none) and are verified exactly like the
  // databases when they are there — backup.sh writes a sidecar per produced file.
  return [...manifest.databases, ...(manifest.blobs ?? [])].map((entry) => {
    const file = path.join(backupDir, entry.backup);
    if (!existsSync(file)) return { backup: entry.backup, state: "absent" };
    const sidecar = `${file}.sha256`;
    if (!existsSync(sidecar)) return { backup: entry.backup, state: "no-sidecar" };
    const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/u)[0];
    const actual = sha256(file);
    return {
      backup: entry.backup,
      state: expected === actual ? "verified" : "mismatch",
      expected,
      actual,
    };
  });
}

/**
 * Load `backupRuntimeDatabases`/`restoreRuntimeDatabases`.
 *
 * dist/ first (what a packaged install has, and what backup.sh already uses),
 * then the TypeScript source through tsx — a restore is the emergency path and
 * refusing to run in a source checkout because nobody ran `npm run build` would
 * be the worst possible moment to insist on it.
 */
export async function loadDatabaseBackupModule(root = repoRoot) {
  const compiled = path.join(root, "dist", "core", "database-backup.js");
  if (existsSync(compiled)) {
    return { module: await import(pathToFileURL(compiled).href), source: compiled };
  }
  const source = path.join(root, "src", "core", "database-backup.ts");
  if (!existsSync(source)) {
    throw new Error(`Neither ${compiled} nor ${source} exists — cannot load the restore API`);
  }
  const { tsImport } = await import("tsx/esm/api");
  return { module: await tsImport(source, import.meta.url), source };
}

async function main(argv) {
  let flags;
  try {
    flags = parseRestoreArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  let workDir = null;
  let searchRoot;
  if (flags.archive) {
    if (!existsSync(flags.archive)) {
      process.stderr.write(`restore: archive not found: ${flags.archive}\n`);
      return 2;
    }
    workDir = mkdtempSync(path.join(tmpdir(), "strada-restore-"));
    try {
      execFileSync("tar", ["-xzf", path.resolve(flags.archive), "-C", workDir], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      rmSync(workDir, { recursive: true, force: true });
      process.stderr.write(`restore: could not extract ${flags.archive}: ${err.message}\n`);
      return 1;
    }
    searchRoot = workDir;
    console.log(`restore: extracted ${flags.archive} to ${workDir}`);
  } else {
    if (!existsSync(flags.backupDir) || !statSync(flags.backupDir).isDirectory()) {
      process.stderr.write(`restore: not a directory: ${flags.backupDir}\n`);
      return 2;
    }
    searchRoot = path.resolve(flags.backupDir);
  }

  try {
    const { module, source } = await loadDatabaseBackupModule();
    const manifestFile = module.BACKUP_MANIFEST_FILE ?? "databases.manifest.json";
    const backupDir = findManifestDir(searchRoot, manifestFile);
    if (!backupDir) {
      process.stderr.write(`restore: no ${manifestFile} in ${searchRoot} or one level below — not a database backup\n`);
      return 2;
    }
    console.log(`restore: using ${source}`);
    const manifest = module.readBackupManifest(backupDir);
    console.log(
      `restore: manifest v${manifest.version} from ${manifest.createdAtIso} — ${manifest.databases.length} database(s), roots: ${Object.entries(manifest.roots).map(([name, dir]) => `${name}=${dir}`).join(", ")}`,
    );

    if (!flags.skipChecksums) {
      const rows = verifyBackupChecksums(backupDir, manifest);
      for (const row of rows) {
        if (row.state === "verified") continue;
        const label = row.state === "no-sidecar" ? "NOT VERIFIED (no .sha256 sidecar)" : row.state.toUpperCase();
        console.log(`restore:   ${row.backup}: ${label}`);
      }
      const bad = rows.filter((row) => row.state === "mismatch" || row.state === "absent");
      if (bad.length > 0) {
        process.stderr.write(
          `restore: refusing to overwrite live databases — ${bad.map((row) => `${row.backup} (${row.state})`).join(", ")}\n`,
        );
        return 1;
      }
      const verified = rows.filter((row) => row.state === "verified").length;
      console.log(`restore: ${verified}/${rows.length} copies checksum-verified; ${rows.length - verified} had no sidecar to verify against`);
    } else {
      console.log("restore: checksum verification SKIPPED (--skip-checksums) — the copies were not verified");
    }

    for (const entry of manifest.databases) {
      const rootPath = flags.roots[entry.root] ?? manifest.roots[entry.root];
      console.log(`restore: ${entry.backup} -> ${rootPath ? path.join(rootPath, entry.relative) : `? (no directory for root "${entry.root}")`}`);
    }

    if (flags.dryRun) {
      console.log("restore: --dry-run, nothing was written");
      return 0;
    }

    const options = {
      backupDir,
      ...(Object.keys(flags.roots).length > 0 ? { roots: flags.roots } : {}),
    };
    // `restoreRuntimeData` puts back the retained attachment BYTES as well as the
    // databases; `restoreRuntimeDatabases` narrows the result to the databases.
    // Prefer the wider one when the installed module has it, so this script never
    // under-reports what it just wrote.
    const outcome = module.restoreRuntimeData
      ? await module.restoreRuntimeData(options)
      : { databases: await module.restoreRuntimeDatabases(options), blobs: [] };
    for (const result of outcome.databases) {
      console.log(`restore: restored ${result.restorePath} (${result.bytes} bytes)`);
    }
    for (const blob of outcome.blobs ?? []) {
      console.log(`restore: restored blob ${blob.restorePath ?? blob.destination} (${blob.bytes} bytes)`);
    }
    const blobCount = (outcome.blobs ?? []).length;
    console.log(
      `restore: ${outcome.databases.length} database(s)${blobCount > 0 ? ` and ${blobCount} retained blob(s)` : ""} restored and integrity-checked`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`restore failed: ${err.message}\n`);
    return 1;
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }
}

/* c8 ignore start — CLI wiring, exercised by restore-script.test.ts and the acceptance runner */
const invokedDirectly =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
