/** The grammar `parseDurationToTimestamp` accepts, for error messages. */
export const DURATION_FORMAT_HINT = "<n>d, <n>h or <n>m — e.g. 7d, 12h, 30m";

/** A `--since` window the parser could read, and whether it had to be clamped. */
export interface DurationWindow {
  /** Lower bound in ms since epoch. Never negative. */
  readonly since: number;
  /**
   * True when the requested duration reaches back past the epoch, so `since` is
   * 0 rather than the literal `now - duration`. Callers must SAY this: a window
   * silently shortened to "everything" reads exactly like one that fit.
   */
  readonly clampedToEpoch: boolean;
}

/**
 * Parse duration shorthand ("1d", "7d", "12h", "30m") into a window whose lower
 * bound is `Date.now()` minus the duration.
 *
 * Returns `null` only when the token is not readable — a token outside the
 * grammar, or a duration too large to convert to milliseconds exactly. It used
 * to return 0 for those, and both callers turned that 0 into "no filter":
 * `metrics --since 1w` printed the full history under a header naming no window
 * (audited 2026-09-02). A caller that gets `null` must refuse and echo the token.
 *
 * audited 2026-09-02: a well-formed window longer than the record itself
 * (`20000d`, `30000d`) computed a negative timestamp and was ALSO rejected — as
 * "Unrecognized --since", a grammar error for a token the grammar accepts. Such
 * a window is now clamped to the epoch and the clamp is reported, so nothing
 * ever caps the window silently.
 */
export function parseDurationWindow(duration: string): DurationWindow | null {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return null;

  const value = parseInt(match[1]!, 10);
  const unit = match[2];

  let ms: number;
  switch (unit) {
    case "d":
      ms = value * 86400000;
      break;
    case "h":
      ms = value * 3600000;
      break;
    case "m":
      ms = value * 60000;
      break;
    default:
      return null;
  }

  // Past 2^53 ms the duration cannot be represented exactly, so no honest
  // bound can be computed from it — that is unreadable, not clamped.
  if (!Number.isSafeInteger(ms)) return null;

  const since = Date.now() - ms;
  return since >= 0 ? { since, clampedToEpoch: false } : { since: 0, clampedToEpoch: true };
}

/**
 * The lower bound alone, for callers that do not report the window they used.
 * `null` still means unreadable; a window clamped to the epoch comes back as 0.
 * Prefer {@link parseDurationWindow} wherever the window is printed or echoed.
 */
export function parseDurationToTimestamp(duration: string): number | null {
  return parseDurationWindow(duration)?.since ?? null;
}
