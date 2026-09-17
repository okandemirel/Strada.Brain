// ---------------------------------------------------------------------------
// Workspace-skill trust records (plan 1.15 / audit 13F3 / D65 / Codex #23).
//
// A workspace-tier skill (`<project>/skills/<name>/`) has its `index.ts|js`
// dynamically imported by `loadSkillTools` — in-process, full privileges. Until
// 2026-09-17 nothing stood between "open a project" and "execute whatever its
// checkout put in skills/*/index.js". This module is that approval step.
//
// The record lives OUTSIDE the project, at `~/.strada/trusted-skills.json`,
// so a checkout cannot approve itself. It is keyed by the canonical identity
// of the project (realpath of the project root) and the skill's directory,
// and holds a sha256 over the skill's executable content — every
// .ts/.js/.mjs/.cjs under the skill directory, sorted, path + bytes. A record
// whose hash no longer matches means the code changed since approval, and the
// skill is untrusted again until re-approved.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustedSkillRecord {
  /** sha256 over the skill's executable content at approval time. */
  readonly sha256: string;
  readonly approvedAtIso: string;
}

export interface TrustedSkillsFile {
  readonly version: 1;
  /** projectId (realpath of the project root) → skillKey (dir relative to root) → record */
  readonly projects: Record<string, Record<string, TrustedSkillRecord>>;
}

export type SkillTrustVerdict =
  | { readonly trusted: true; readonly sha256: string | null }
  | { readonly trusted: false; readonly reason: string; readonly sha256: string };

const EXECUTABLE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const ENTRY_POINTS = ["index.ts", "index.js"];

// ---------------------------------------------------------------------------
// Record file location — always under the user's home, never in the project.
// ---------------------------------------------------------------------------

/** `~/.strada/trusted-skills.json`. Resolved at call time so a test HOME applies. */
export function trustedSkillsPath(): string {
  return join(homedir(), ".strada", "trusted-skills.json");
}

async function readTrustFile(): Promise<TrustedSkillsFile> {
  try {
    const raw = await readFile(trustedSkillsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<TrustedSkillsFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.projects || typeof parsed.projects !== "object") {
      return { version: 1, projects: {} };
    }
    return { version: 1, projects: parsed.projects };
  } catch {
    return { version: 1, projects: {} };
  }
}

async function writeTrustFile(file: TrustedSkillsFile): Promise<void> {
  const path = trustedSkillsPath();
  await mkdir(join(homedir(), ".strada"), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Identity + hashing
// ---------------------------------------------------------------------------

/** Canonical project identity: the realpath of the project root. */
export async function projectIdentity(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch {
    return projectRoot;
  }
}

/**
 * The key a skill directory gets inside its project's record: its path
 * relative to the canonical project root (e.g. `skills/deploy`), or just the
 * directory name when it does not sit under the root.
 */
export async function skillKey(projectId: string, skillPath: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(skillPath);
  } catch {
    real = skillPath;
  }
  const rel = relative(projectId, real);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return basename(real);
  return rel.split(sep).join("/");
}

/**
 * sha256 over every executable file under the skill directory (sorted by
 * relative path; each contributes `<relpath>\0<bytes>\0`). Symlinks are not
 * followed. Returns `null` when the directory holds no executable file at all.
 */
export async function hashSkillExecutableContent(skillPath: string): Promise<string | null> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && EXECUTABLE_EXTENSIONS.has(extensionOf(entry.name))) {
        files.push(full);
      }
    }
  };
  await walk(skillPath);
  if (files.length === 0) return null;

  const rels = files
    .map((f) => ({ full: f, rel: relative(skillPath, f).split(sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const { full, rel } of rels) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

async function hasEntryPoint(skillPath: string): Promise<boolean> {
  for (const filename of ENTRY_POINTS) {
    try {
      if ((await stat(join(skillPath, filename))).isFile()) return true;
    } catch {
      // not present
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * Decide whether a workspace-tier skill's code may be imported for this
 * project. A skill with no entry point imports nothing (`loadSkillTools`
 * returns before any `import()`), so there is nothing to approve and it is
 * trusted trivially. Otherwise a record for (project, skill) must exist AND
 * its hash must equal the current hash of the skill's executable content.
 */
export async function assessWorkspaceSkillTrust(
  projectRoot: string,
  skillPath: string,
  skillName: string,
): Promise<SkillTrustVerdict> {
  if (!(await hasEntryPoint(skillPath))) {
    return { trusted: true, sha256: null };
  }
  const sha256 = (await hashSkillExecutableContent(skillPath)) ?? "";
  const projectId = await projectIdentity(projectRoot);
  const key = await skillKey(projectId, skillPath);
  const record = (await readTrustFile()).projects[projectId]?.[key];
  const howTo = `run \`strada skill trust ${skillName}\` in ${projectId} to approve it (recorded in ${trustedSkillsPath()})`;

  if (!record) {
    return {
      trusted: false,
      sha256,
      reason: `Workspace skill code is not approved for this project — ${howTo}`,
    };
  }
  if (record.sha256 !== sha256) {
    return {
      trusted: false,
      sha256,
      reason:
        `Workspace skill code changed since approval (sha256 ${record.sha256.slice(0, 12)} -> ${sha256.slice(0, 12)}) — ` +
        howTo,
    };
  }
  return { trusted: true, sha256 };
}

// ---------------------------------------------------------------------------
// Approve / revoke
// ---------------------------------------------------------------------------

export interface ApprovalResult {
  readonly projectId: string;
  readonly skillKey: string;
  readonly sha256: string;
  readonly recordPath: string;
}

/**
 * Record the skill's CURRENT executable content as approved for this project.
 * Throws when the directory has no executable content (nothing to approve).
 */
export async function approveWorkspaceSkill(projectRoot: string, skillPath: string): Promise<ApprovalResult> {
  const sha256 = await hashSkillExecutableContent(skillPath);
  if (sha256 === null) {
    throw new Error(`Nothing to approve: ${skillPath} holds no executable file (.ts/.js/.mjs/.cjs)`);
  }
  const projectId = await projectIdentity(projectRoot);
  const key = await skillKey(projectId, skillPath);
  const file = await readTrustFile();
  const projects: Record<string, Record<string, TrustedSkillRecord>> = { ...file.projects };
  projects[projectId] = {
    ...(projects[projectId] ?? {}),
    [key]: { sha256, approvedAtIso: new Date().toISOString() },
  };
  await writeTrustFile({ version: 1, projects });
  return { projectId, skillKey: key, sha256, recordPath: trustedSkillsPath() };
}

/** Remove the record for (project, skill). Returns whether one existed. */
export async function revokeWorkspaceSkill(projectRoot: string, skillPath: string): Promise<boolean> {
  const projectId = await projectIdentity(projectRoot);
  const key = await skillKey(projectId, skillPath);
  const file = await readTrustFile();
  const project = file.projects[projectId];
  if (!project || !(key in project)) return false;
  const rest: Record<string, TrustedSkillRecord> = { ...project };
  delete rest[key];
  const projects: Record<string, Record<string, TrustedSkillRecord>> = { ...file.projects };
  if (Object.keys(rest).length === 0) {
    delete projects[projectId];
  } else {
    projects[projectId] = rest;
  }
  await writeTrustFile({ version: 1, projects });
  return true;
}
