/**
 * The campaign scope gate's flag (CAMPAIGN_SCOPE_GATE).
 *
 * config reads it, and config is a foundation module, so the flag is declared
 * here; campaign/scope-types.ts re-exports it beside the gate's other shapes.
 *
 * Pure constants and one pure parser: nothing here reads a file or a clock.
 */

/**
 * off:    today's behaviour; nothing is extracted, written, run or judged.
 * shadow: everything is measured and judged, and the verdict is recorded, but
 *         every decision stays today's.
 * on:     the verdict decides green.
 */
export const SCOPE_GATE_MODES = ["off", "shadow", "on"] as const;
export type ScopeGateMode = (typeof SCOPE_GATE_MODES)[number];

export const DEFAULT_SCOPE_GATE_MODE: ScopeGateMode = "off";

export const SCOPE_GATE_ENV = "CAMPAIGN_SCOPE_GATE";

/**
 * Exactly off, shadow or on; unset or empty is the default. Anything else is
 * off with a warning that names it: an unreadable value must never switch
 * enforcement on (it parks milestones and commits into the user's project),
 * and a typo in one setting must not stop the daemon from booting. "true" and
 * "1" are unreadable here on purpose — a boolean does not say which mode.
 */
export function parseScopeGateMode(raw: string | undefined): { mode: ScopeGateMode; warning?: string } {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return { mode: DEFAULT_SCOPE_GATE_MODE };
  if ((SCOPE_GATE_MODES as readonly string[]).includes(value)) return { mode: value as ScopeGateMode };
  return {
    mode: "off",
    warning: `${SCOPE_GATE_ENV}=${JSON.stringify((raw ?? "").slice(0, 40))} is not off, shadow or on — the scope gate stays off`,
  };
}
