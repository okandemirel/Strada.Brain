/**
 * An integer tool argument: a number, or a string of digits (models often
 * send "20"). Anything else is refused by name instead of becoming NaN:
 * `count: "abc"` ran `git log -NaN`, and `offset: "x"` read nothing under a
 * NaN header (review TLS-17). Range clamping stays with the caller.
 */
export function integerArg(
  input: Record<string, unknown>,
  name: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const raw = input[name];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value)) {
    return { ok: false, error: `Error: '${name}' must be an integer, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
}
