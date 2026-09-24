/**
 * Shared utilities for trigger implementations.
 */

import type { Cron } from "croner";

/**
 * Floor a timestamp to the start of its minute (for same-minute dedup).
 */
export function floorToMinute(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

/** How far back an evaluation looks for an occurrence nobody saw (a restart, a slow tick). */
export const CATCH_UP_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Whether `cron` has an occurrence in (lastChecked, now], looking back at most
 * `windowMs`.
 *
 * croner's `match()` treats a 5-field pattern as second :00, and the heartbeat
 * ticks every 30-60 s at whatever second it drifted to, so `match(now)` alone
 * almost never sees "0 9 * * *". Asking for the first occurrence after the
 * previous look finds it whatever second the tick lands on. The caller advances
 * `lastChecked` on every evaluation so one occurrence is due exactly once.
 * `match(now)` still counts for a first look at the construction instant, where
 * the interval is empty.
 */
export function isOccurrenceDue(
  cron: Cron,
  lastChecked: Date,
  now: Date,
  windowMs: number = CATCH_UP_WINDOW_MS,
): boolean {
  if (cron.match(now)) return true;
  const from = new Date(Math.max(lastChecked.getTime(), now.getTime() - windowMs));
  const next = cron.nextRun(from);
  return next !== null && next.getTime() <= now.getTime();
}
