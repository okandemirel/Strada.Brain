/**
 * Shared utilities for trigger implementations.
 */

/**
 * Floor a timestamp to the start of its minute (for same-minute dedup).
 */
export function floorToMinute(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}
