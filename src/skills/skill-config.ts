// ---------------------------------------------------------------------------
// Skill configuration persistence — reads/writes <app home>/skills.json
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveStradaHome } from "../common/runtime-paths.js";
import type { SkillConfig } from "./types.js";

/**
 * The app home every other runtime file uses (STRADA_HOME, else `~/.strada`,
 * or `%LOCALAPPDATA%\Strada` on Windows). This was `homedir()/.strada`
 * whatever STRADA_HOME said, so a deployment with its own home shared the
 * user's file, and every test run's skill toggles rewrote the developer's own
 * ~/.strada/skills.json (measured 2026-10-11).
 */
function stradaDir(): string {
  return resolveStradaHome();
}

/** Full path to the skills configuration file. */
function skillsJsonPath(): string {
  return join(stradaDir(), "skills.json");
}

/**
 * Where the file was before it followed the app home, when that is somewhere
 * else: only the Windows default moved. Its `enabled: false` entries still
 * hold until the next write puts them in the app home; reading nothing there
 * would quietly re-enable those skills (SEC-15). An explicit STRADA_HOME names
 * the home, and is what keeps a test run off the user's own file.
 */
function legacySkillsJsonPath(): string | null {
  if (process.env["STRADA_HOME"]?.trim()) return null;
  const legacy = join(homedir(), ".strada", "skills.json");
  return legacy === skillsJsonPath() ? null : legacy;
}

/** The file's text, or null when it does not exist; any other failure throws. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read the user's skill configuration from `<app home>/skills.json`.
 * Returns a default empty config if the file does not exist. A file that
 * exists but cannot be read or parsed (SEC-15) is NOT the same as an empty
 * one — it may hold the user's `enabled: false` entries — so the result
 * carries `unreadable` and callers fail closed.
 */
export async function readSkillConfig(): Promise<SkillConfig> {
  let raw: string | null;
  try {
    raw = await readIfPresent(skillsJsonPath());
    const legacy = raw === null ? legacySkillsJsonPath() : null;
    if (legacy) raw = await readIfPresent(legacy);
  } catch (err) {
    return { entries: {}, unreadable: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null) return { entries: {} };
  let parsed: SkillConfig;
  try {
    parsed = JSON.parse(raw) as SkillConfig;
  } catch (err) {
    return { entries: {}, unreadable: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Basic runtime validation
  if (!parsed || typeof parsed !== "object") return { entries: {}, unreadable: "not a JSON object" };
  if (!parsed.entries || typeof parsed.entries !== "object") {
    return { entries: {} };
  }
  delete parsed.unreadable;
  // Validate each entry has the correct shape
  for (const [key, entry] of Object.entries(parsed.entries)) {
    if (typeof entry !== "object" || entry === null) {
      delete parsed.entries[key];
      continue;
    }
    if (typeof (entry as Record<string, unknown>).enabled !== "boolean") {
      (entry as Record<string, unknown>).enabled = true; // Default to enabled
    }
  }
  return parsed;
}

/**
 * Write the skill configuration to `<app home>/skills.json`.
 * Creates the app home if it does not exist. The file is
 * replaced atomically (temp file + rename, SEC-15): a crash mid-write leaves
 * the previous file, never a truncated one.
 */
export async function writeSkillConfig(config: SkillConfig): Promise<void> {
  const { unreadable: _unreadable, ...persisted } = config;
  await mkdir(stradaDir(), { recursive: true });
  const target = skillsJsonPath();
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(persisted, null, 2) + "\n", "utf-8");
  try {
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

/**
 * Enable or disable a skill by name. Creates a new entry if one
 * does not already exist; preserves existing env/config fields.
 * Refuses to rewrite a skills.json it cannot read (SEC-15): that would
 * silently drop every other entry in it.
 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const config = await readSkillConfig();
  if (config.unreadable) {
    throw new Error(`${skillsJsonPath()} could not be read (${config.unreadable}); repair or remove it first`);
  }
  const existing = config.entries[name];
  config.entries[name] = {
    ...existing,
    enabled,
  };
  await writeSkillConfig(config);
}
