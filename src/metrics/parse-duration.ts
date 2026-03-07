/**
 * Parse duration shorthand (e.g., "1d", "7d", "1h", "30m") into a Unix timestamp.
 * Returns Date.now() minus the parsed duration. Returns 0 if unparseable.
 */
export function parseDurationToTimestamp(duration: string): number {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return 0;

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
      return 0;
  }

  return Date.now() - ms;
}
