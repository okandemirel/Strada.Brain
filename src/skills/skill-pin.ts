/**
 * Skill commit pinning — an audit trail for remotely-installed code.
 *
 * Measured 2026-08-23: installing a skill git-clones an arbitrary repo whose
 * entry point executes with full process privileges on next load, and `skill
 * update` ran a bare `git pull` with no record of WHAT changed between fetch
 * and exec. A revoked/compromised upstream could ship anything silently.
 *
 * Pinning here does NOT block updates (there is no review UI to gate them);
 * it makes every transition explicit: the exact SHA installed, the SHA after
 * each update, and a loud warning when on-disk HEAD drifts from the recorded
 * pin (out-of-band mutation between loads).
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execFileNoThrow, type ExecFileResult } from "../utils/execFileNoThrow.js";

const execFileAsync = promisify(execFile);

const PIN_FILE = ".strada-skill-pin.json";

export interface SkillPin {
  /** The exact commit this skill's code was pinned at. */
  readonly pinnedSha: string;
  readonly pinnedAtIso: string;
}

/**
 * SEC-16: environment for every git command run on a skill checkout. The
 * ceiling stops git from walking up to an enclosing repository when the skill
 * directory has no `.git` of its own (it would pull and pin THAT repository),
 * and the protocol allowlist is the one install uses (skill-installer.ts), so
 * an update cannot fetch over any other transport either.
 */
export function skillGitEnv(skillDir: string): Record<string, string> {
  return { GIT_ALLOW_PROTOCOL: "https", GIT_CEILING_DIRECTORIES: dirname(resolve(skillDir)) };
}

/** Best-effort: not a git repo (workspace skills) → null, never throws. */
export async function readCurrentGitSha(skillDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", skillDir, "rev-parse", "HEAD"], {
      timeout: 10_000,
      env: { ...process.env, ...skillGitEnv(skillDir) },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `skill update`: fast-forward the skill's own checkout (SEC-16 — never an
 * enclosing repository, https only, no submodule recursion).
 */
export function pullSkillCheckout(skillDir: string): Promise<ExecFileResult> {
  return execFileNoThrow(
    "git",
    ["-C", skillDir, "pull", "--ff-only", "--no-recurse-submodules"],
    60_000,
    skillGitEnv(skillDir),
  );
}

export async function writePin(skillDir: string, sha: string): Promise<void> {
  const pin: SkillPin = { pinnedSha: sha, pinnedAtIso: new Date().toISOString() };
  await writeFile(join(skillDir, PIN_FILE), JSON.stringify(pin, null, 2), "utf-8");
}

/**
 * Record the CURRENT HEAD as the pin. Returns the sha recorded, or null when
 * the directory is not a git checkout.
 */
export async function recordPinnedCommit(skillDir: string): Promise<string | null> {
  const sha = await readCurrentGitSha(skillDir);
  if (sha) await writePin(skillDir, sha);
  return sha;
}

export async function readPin(skillDir: string): Promise<SkillPin | null> {
  try {
    const raw = await readFile(join(skillDir, PIN_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SkillPin>;
    return typeof parsed.pinnedSha === "string" ? { pinnedSha: parsed.pinnedSha, pinnedAtIso: parsed.pinnedAtIso ?? "" } : null;
  } catch {
    return null;
  }
}

/**
 * Loader-side drift check: warn when a git-managed skill's HEAD no longer
 * matches its recorded pin — the code about to execute changed outside any
 * recorded update. Returns the warning message, or null ONLY when the pin was
 * measured and matches (or the skill was never pinned).
 */
export async function describePinDrift(skillDir: string, name: string): Promise<string | null> {
  const pin = await readPin(skillDir);
  if (!pin) return null; // never pinned (pre-existing or workspace skill)
  const head = await readCurrentGitSha(skillDir);
  if (!head) {
    // audited 2026-09-02: this used to return null — indistinguishable from
    // "HEAD matches the pin". A pin only ever exists because a git HEAD was
    // read at install/update time, so a pinned dir with no readable HEAD is
    // an unverifiable checkout (.git removed, git off PATH, rev-parse failing),
    // never a benign workspace skill. Say the check could not be made.
    return (
      `Skill "${name}" was pinned at ${pin.pinnedSha.slice(0, 9)} (pinned ${pin.pinnedAtIso}) but its ` +
      `git HEAD could not be read (not a git checkout, or git unavailable/failed) — the code about to ` +
      `execute cannot be verified against its pin. Inspect ${skillDir} or reinstall the skill.`
    );
  }
  if (head === pin.pinnedSha) return null;
  return (
    `Skill "${name}" is checked out at ${head.slice(0, 9)} but was pinned at ${pin.pinnedSha.slice(0, 9)} ` +
    `(pinned ${pin.pinnedAtIso}). Its code changed without a recorded update and will execute with full ` +
    `process privileges — verify the source or run \`strada skill update ${name}\` to re-pin.`
  );
}
