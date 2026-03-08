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
import type {
  ITrigger,
  TriggerMetadata,
  TriggerState,
} from "../daemon-types.js";

/**
 * Floor a timestamp to the start of its minute (for same-minute comparison).
 */
function floorToMinute(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

export class CronTrigger implements ITrigger {
  readonly metadata: TriggerMetadata;
  private readonly cron: Cron;
  private lastFired: Date | null = null;

  /**
   * @param metadata Trigger metadata (name, description, type)
   * @param cronExpression Standard 5-field cron expression
   * @param timezone IANA timezone string (e.g., "UTC", "Europe/Istanbul")
   */
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

    return this.cron.match(now);
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
