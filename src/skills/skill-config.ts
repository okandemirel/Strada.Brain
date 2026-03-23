// ---------------------------------------------------------------------------
// Skill configuration persistence — reads/writes ~/.strada/skills.json
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SkillConfig } from "./types.js";

/** Default directory for Strada user config. */
function stradaDir(): string {
  return join(homedir(), ".strada");
}

/** Full path to the skills configuration file. */
function skillsJsonPath(): string {
  return join(stradaDir(), "skills.json");
}

/**
 * Read the user's skill configuration from `~/.strada/skills.json`.
 * Returns a default empty config if the file does not exist.
 */
export async function readSkillConfig(): Promise<SkillConfig> {
  try {
    const raw = await readFile(skillsJsonPath(), "utf-8");
    const parsed = JSON.parse(raw) as SkillConfig;
    // Ensure the entries field exists
    if (!parsed.entries || typeof parsed.entries !== "object") {
      return { entries: {} };
    }
    return parsed;
  } catch {
    return { entries: {} };
  }
}

/**
 * Write the skill configuration to `~/.strada/skills.json`.
 * Creates the `~/.strada/` directory if it does not exist.
 */
export async function writeSkillConfig(config: SkillConfig): Promise<void> {
  await mkdir(stradaDir(), { recursive: true });
  await writeFile(skillsJsonPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Enable or disable a skill by name. Creates a new entry if one
 * does not already exist; preserves existing env/config fields.
 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const config = await readSkillConfig();
  const existing = config.entries[name];
  config.entries[name] = {
    ...existing,
    enabled,
  };
  await writeSkillConfig(config);
}
