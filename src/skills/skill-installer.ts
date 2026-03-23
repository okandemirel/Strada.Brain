// ---------------------------------------------------------------------------
// Shared skill installation logic — used by both CLI and dashboard API.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { homedir } from "node:os";
import { stat, rm } from "node:fs/promises";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { setSkillEnabled } from "./skill-config.js";

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

  const targetDir = join(homedir(), ".strada", "skills", name);

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

  // Validate SKILL.md exists
  try {
    await stat(join(targetDir, "SKILL.md"));
  } catch {
    // Non-fatal — warn but continue
  }

  // Enable by default
  await setSkillEnabled(name, true);

  return { success: true, targetDir };
}
