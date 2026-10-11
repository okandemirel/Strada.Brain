// ---------------------------------------------------------------------------
// Shared skill installation logic — used by both CLI and dashboard API.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { stat, rm } from "node:fs/promises";
import { resolveStradaHomeEntry } from "../common/strada-home-entry.js";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { setSkillEnabled } from "./skill-config.js";
import { recordPinnedCommit } from "./skill-pin.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Validate that a skill name contains only safe characters. */
export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
}

/**
 * Validate that a repo URL is a safe HTTPS URL.
 * Blocks dangerous git protocols (ext::, file://, ssh://) that could
 * lead to command execution or local file exfiltration.
 */
export function isValidRepoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface InstallResult {
  success: boolean;
  error?: string;
  targetDir?: string;
  /** The git commit the installed skill was pinned at (git-sourced installs only). */
  pinnedSha?: string;
}

/**
 * Install a skill from a git repository URL.
 *
 * Steps: validate inputs → verify git → check not installed → shallow clone → validate SKILL.md → enable.
 */
export async function installSkillFromRepo(
  name: string,
  repoUrl: string,
): Promise<InstallResult> {
  if (!isValidSkillName(name)) {
    return { success: false, error: `Invalid skill name: "${name}". Only alphanumeric, hyphen, underscore, and dot are allowed.` };
  }

  if (!isValidRepoUrl(repoUrl)) {
    return { success: false, error: "Only HTTPS repository URLs are allowed." };
  }

  // Verify git is available
  const gitCheck = await execFileNoThrow("git", ["--version"]);
  if (gitCheck.exitCode !== 0) {
    return { success: false, error: "git is not installed or not in PATH." };
  }

  // The managed directory is resolved as a whole, never per skill: the loader
  // scans one directory, so a skill must land beside the ones already there.
  const targetDir = join(resolveStradaHomeEntry("skills"), name);

  // Check if already installed
  try {
    const s = await stat(targetDir);
    if (s.isDirectory()) {
      return { success: false, error: `Skill "${name}" is already installed at ${targetDir}. Use update or remove first.` };
    }
  } catch {
    // Does not exist — good
  }

  // Shallow clone with protocol restriction (defense-in-depth)
  const result = await execFileNoThrow(
    "git",
    ["clone", "--depth", "1", "--", repoUrl, targetDir],
    60_000,
    { GIT_ALLOW_PROTOCOL: "https" },
  );
  if (result.exitCode !== 0) {
    // Clean up partial clone on failure
    try { await rm(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { success: false, error: `Git clone failed: ${result.stderr || result.stdout}` };
  }

  // Validate SKILL.md exists. audited 2026-09-02: this catch used to be a bare
  // "warn but continue" comment with no warning anywhere — the clone was
  // recorded as enabled and reported "installed", yet discoverSkills requires
  // SKILL.md, so it could never load, never appeared in `skill list`, and a
  // retry said "already installed". A repo without SKILL.md is not a skill:
  // remove the clone and say so.
  try {
    await stat(join(targetDir, "SKILL.md"));
  } catch {
    try { await rm(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return {
      success: false,
      error: `Cloned repository has no SKILL.md at its root — not a skill. Nothing was installed or enabled (${repoUrl}).`,
    };
  }

  // Pin the cloned commit — the audit anchor for every future update/drift check.
  let pinnedSha: string | null = null;
  try {
    pinnedSha = await recordPinnedCommit(targetDir);
  } catch { /* pinning is best-effort; install proceeds */ }

  // Enable by default. setSkillEnabled refuses an unreadable skills.json
  // (SEC-15); a clone left behind by that failure made a retry say "already
  // installed", and once the file was repaired its missing entry counted as
  // enabled and the code loaded. A reported failure leaves no clone.
  try {
    await setSkillEnabled(name, true);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const removed = await rm(targetDir, { recursive: true, force: true }).then(() => true, () => false);
    return {
      success: false,
      error: removed
        ? `Could not enable "${name}": ${reason}. The clone was removed; nothing was installed (${repoUrl}).`
        : `Could not enable "${name}": ${reason}. The clone could not be removed: ${targetDir}; remove it before retrying.`,
    };
  }

  return { success: true, targetDir, pinnedSha: pinnedSha ?? undefined };
}
