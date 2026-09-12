/**
 * CronTrigger
 *
 * Implements ITrigger using the croner library for cron pattern matching.
 * Fires when the current minute matches the cron expression. Prevents
 * double-fire within the same minute via lastFired tracking.
 *
 * The circuit breaker state is managed externally by HeartbeatLoop (Plan 04),
 * not by this trigger itself.
 *
 * Used by: TriggerRegistry, HeartbeatLoop
 */

import { Cron } from "croner";

/** How far back a restarted daemon looks for an occurrence it missed. */
const CATCH_UP_WINDOW_MS = 6 * 60 * 60_000;
import type {
  ITrigger,
  TriggerMetadata,
  TriggerState,
} from "../daemon-types.js";
import { floorToMinute } from "./trigger-utils.js";

export class CronTrigger implements ITrigger {
  readonly metadata: TriggerMetadata;
  private readonly cron: Cron;
  private lastFired: Date | null = null;

  /**
   * @param metadata Trigger metadata (name, description, type)
   * @param cronExpression Standard 5-field cron expression
   * @param timezone IANA timezone string (e.g., "UTC", "Europe/Istanbul")
   */
  /**
   * The last time this trigger was ASKED, so a missed occurrence is visible.
   * Starts at construction: a trigger created at 02:59 and first asked at
   * 03:01 has missed its 03:00 occurrence (Codex 2026-09-13 AG#12).
   */
  private lastChecked: Date = new Date();

  constructor(
    metadata: TriggerMetadata,
    cronExpression: string,
    timezone?: string,
  ) {
    this.metadata = metadata;
    this.cron = new Cron(cronExpression, {
      timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      paused: true,
    });
  }

  /**
   * Check if the trigger should fire at the given time.
   *
   * Returns false if:
   * - The cron pattern does not match the current minute
   * - The trigger has already fired in the current minute (double-fire prevention)
   */
  shouldFire(now: Date): boolean {
    // Prevent double-fire in the same minute
    if (this.lastFired && floorToMinute(this.lastFired) === floorToMinute(now)) {
      return false;
    }
    if (this.cron.match(now)) return true;
    // A DUE OCCURRENCE IS NOT LOST BECAUSE NOBODY LOOKED IN ITS MINUTE. The
    // match was against the current minute alone, so an evaluation at
    // 02:59:50 and the next at 03:01:10 — a busy foreground, a restart, a
    // slow tick — skipped "0 3 * * *" entirely, and the work never ran
    // (Codex 2026-09-13 AG#12). An occurrence between the last look and this
    // one is due now.
    const since = this.lastChecked;
    this.lastChecked = now;
    // Bounded: a daemon that was down for a week runs the last occurrence,
    // not every one it missed.
    const from = new Date(Math.max(since.getTime(), now.getTime() - CATCH_UP_WINDOW_MS));
    const missed = this.cron.nextRun(from);
    return missed !== null && missed.getTime() <= now.getTime();
  }

  /**
   * Called after the trigger successfully fires. Records the fire time
   * to prevent double-fire within the same minute.
   */
  onFired(now: Date): void {
    this.lastFired = now;
  }

  /**
   * Get the next scheduled fire time from croner.
   */
  getNextRun(): Date | null {
    return this.cron.nextRun() ?? null;
  }

  /**
   * Get the current trigger state.
   * Always returns 'active' -- circuit breaker state is managed externally
   * by HeartbeatLoop.
   */
  getState(): TriggerState {
    return "active";
  }
}
