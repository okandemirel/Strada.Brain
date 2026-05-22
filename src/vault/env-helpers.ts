/**
 * Vault env-var parsing helpers.
 *
 * Centralizes the "parse a positive integer from process.env with fallback"
 * pattern that previously lived as a private function in each module that
 * needed it (chunker.ts, embedding-adapter.ts). One implementation means one
 * place to evolve the parsing semantics (e.g. add range clamping later).
 */

/**
 * Parse `process.env[name]` as a positive integer.
 *
 * - Returns `defaultValue` if the variable is unset, blank, non-numeric, or non-positive.
 * - Non-integer numeric values are floored (e.g. `"3.7"` → `3`).
 * - The default itself is returned as-is — callers are expected to pass a
 *   sane positive integer.
 *
 * @param name          Environment variable name.
 * @param defaultValue  Value returned when the env var is missing or invalid.
 */
export function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}
