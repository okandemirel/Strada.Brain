// ---------------------------------------------------------------------------
// Skill gating — checks whether a skill's declared requirements are met.
// ---------------------------------------------------------------------------

import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import type { SkillRequirements } from "./types.js";

export interface GateResult {
  passed: boolean;
  reasons: string[];
}

/**
 * Check all requirement gates for a skill.
 *
 * - **bins**: uses `which` (unix) / `where /q` (windows) via `execFileNoThrow`
 * - **env**: verifies `process.env[key]` is defined and non-empty
 * - **config**: dot-path traversal on the provided config object
 *
 * Returns `{ passed: true, reasons: [] }` when there are no requirements.
 */
export async function checkGates(
  requires: SkillRequirements | undefined,
  config?: Record<string, unknown>,
  activeSkillNames?: ReadonlySet<string>,
): Promise<GateResult> {
  if (!requires) {
    return { passed: true, reasons: [] };
  }

  const reasons: string[] = [];

  // --- binary checks (async) ---
  if (requires.bins && requires.bins.length > 0) {
    const isWindows = process.platform === "win32";
    const whichCmd = isWindows ? "where" : "which";

    const binChecks = requires.bins.map(async (bin) => {
      const args = isWindows ? ["/q", bin] : [bin];
      const result = await execFileNoThrow(whichCmd, args);
      if (result.exitCode !== 0) {
        reasons.push(`Required binary not found: ${bin}`);
      }
    });
    await Promise.all(binChecks);
  }

  // --- env checks ---
  if (requires.env) {
    for (const key of requires.env) {
      const value = process.env[key];
      if (value === undefined || value === "") {
        reasons.push(`Required environment variable not set: ${key}`);
      }
    }
  }

  // --- config checks (dot-path traversal) ---
  if (requires.config) {
    for (const dotPath of requires.config) {
      if (!resolveDotPath(config, dotPath)) {
        reasons.push(`Required config key missing: ${dotPath}`);
      }
    }
  }

  // --- skill dependency checks ---
  if (requires.skills?.length) {
    for (const requiredSkill of requires.skills) {
      if (!activeSkillNames?.has(requiredSkill)) {
        reasons.push(`Required skill "${requiredSkill}" is not active`);
      }
    }
  }

  return { passed: reasons.length === 0, reasons };
}

/**
 * Traverse a nested object by dot-separated path.
 * Returns true if the leaf value is defined and non-null.
 */
function resolveDotPath(obj: Record<string, unknown> | undefined, path: string): boolean {
  if (!obj) return false;
  const segments = path.split(".");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return false;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current !== undefined && current !== null;
}
