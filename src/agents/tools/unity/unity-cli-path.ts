/**
 * Where the Unity Hub CLI (`unity`) lives on this machine.
 *
 * Audited 2026-09-02: both callers hardcoded `/Users/okan/.unity/bin/unity`,
 * so on any other account or machine the prerender pipeline and the Asset
 * Store link step failed with an error naming a stranger's home directory,
 * and the only override (`STRADA_UNITY_CLI`) was documented nowhere. The
 * install location is Unity's standard `~/.unity/bin/unity`; only the home
 * directory was ever machine-specific.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const UNITY_CLI_ENV = "STRADA_UNITY_CLI";

/** The CLI path to try: the override when set, else `~/.unity/bin/unity` for the current user. */
export function resolveUnityCliPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const override = env[UNITY_CLI_ENV]?.trim();
  if (override) return override;
  return join(home, ".unity", "bin", "unity");
}

/** The sentence a caller appends when the CLI is not where it looked. */
export function unityCliMissingHelp(): string {
  return `Set ${UNITY_CLI_ENV} to the Unity Hub CLI binary if it is installed elsewhere.`;
}
