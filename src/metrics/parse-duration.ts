/** The grammar `parseDurationToTimestamp` accepts, for error messages. */
export const DURATION_FORMAT_HINT = "<n>d, <n>h or <n>m — e.g. 7d, 12h, 30m";

/**
 * Parse duration shorthand (e.g., "1d", "7d", "1h", "30m") into a Unix timestamp:
 * Date.now() minus the parsed duration.
 *
 * Returns `null` when the token is not readable. It used to return 0, and both
 * callers turned that 0 into "no filter" — `metrics --since 1w` printed the full
 * history under a header that named no window (audited 2026-09-02). A caller
 * that gets `null` must refuse and echo the token, not degrade to all time.
 */
export function parseDurationToTimestamp(duration: string): number | null {
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

  // An overflowed duration is not a window either: `999999999999d` used to
  // yield a hugely negative timestamp that matched every row — the same
  // all-time answer by a different route.
  if (!Number.isSafeInteger(ms)) return null;
  const since = Date.now() - ms;
  return since >= 0 ? since : null;
}
