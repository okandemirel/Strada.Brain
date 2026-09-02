// ---------------------------------------------------------------------------
// Skill gating — checks whether a skill's declared requirements are met.
// ---------------------------------------------------------------------------

import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import type { SkillRequirements } from "./types.js";

export interface GateResult {
  passed: boolean;
  reasons: string[];
  /**
   * Gates that could not be measured because the caller supplied no evidence
   * to check against (e.g. `requires.config` with no config object). These are
   * neither failures nor passes — callers must show them, never hide them.
   */
  unevaluated?: string[];
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
  const unevaluated: string[] = [];

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
  // audited 2026-09-02: with `config` undefined this used to push "Required
  // config key missing: <path>" for every declared key — a verdict about a
  // lookup that never ran, permanently gating the skill. An absent config
  // object is unevaluable, so it is reported as such (same rule the skills
  // gate below already applies), never as a measured failure.
  if (requires.config?.length) {
    if (config === undefined) {
      unevaluated.push(
        `Config gate not evaluated (no config object supplied): ${requires.config.join(", ")}`,
      );
    } else {
      for (const dotPath of requires.config) {
        if (!resolveDotPath(config, dotPath)) {
          reasons.push(`Required config key missing: ${dotPath}`);
        }
      }
    }
  }

  // --- skill dependency checks ---
  // Only enforce skill-to-skill dependencies when the caller actually tracks
  // active skills. When activeSkillNames is undefined the dependency is
  // unevaluable, so we must NOT fail it — otherwise every skill declaring
  // `requires.skills` is permanently blocked (no caller passes the set today).
  // audited 2026-09-02: not failing was only half the rule. The gate then
  // disappeared from the result entirely — `passed: true`, nothing in
  // `reasons`, nothing in `unevaluated` — so a dependency nobody looked at
  // reported identically to one that was looked at and met. Show, never hide:
  // an untracked set is reported unevaluated, exactly like an absent config.
  // An EMPTY set is evidence ("nothing is active"), not absence of it, and is
  // still measured.
  if (requires.skills?.length) {
    if (activeSkillNames === undefined) {
      unevaluated.push(
        `Skill dependency gate not evaluated (caller tracks no active skills): ${requires.skills.join(", ")}`,
      );
    } else {
      for (const requiredSkill of requires.skills) {
        if (!activeSkillNames.has(requiredSkill)) {
          reasons.push(`Required skill "${requiredSkill}" is not active`);
        }
      }
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    ...(unevaluated.length > 0 ? { unevaluated } : {}),
  };
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
