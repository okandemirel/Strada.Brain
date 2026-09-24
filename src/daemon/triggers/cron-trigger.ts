/**
 * CronTrigger
 *
 * Implements ITrigger using the croner library for cron pattern matching.
 * Fires once for each occurrence that fell since the previous evaluation
 * (see isOccurrenceDue). Prevents double-fire within the same minute via
 * lastFired tracking.
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
import { floorToMinute, isOccurrenceDue } from "./trigger-utils.js";

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
  /** lastChecked before the look that made the last fire due (see onSubmitFailed). */
  private checkedBeforeLastLook: Date = this.lastChecked;

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
   * - No occurrence fell since the previous evaluation
   * - The trigger has already fired in the current minute (double-fire prevention)
   */
  shouldFire(now: Date): boolean {
    // Prevent double-fire in the same minute
    if (this.lastFired && floorToMinute(this.lastFired) === floorToMinute(now)) {
      return false;
    }
    // A DUE OCCURRENCE IS NOT LOST BECAUSE NOBODY LOOKED IN ITS MINUTE
    // (Codex 2026-09-13 AG#12): an occurrence between the last look and this
    // one is due now. Every look advances lastChecked — including one that
    // matched, which used to leave it behind so the next look found the same
    // occurrence again and fired it twice.
    const since = this.lastChecked;
    this.checkedBeforeLastLook = since;
    this.lastChecked = now;
    // Bounded (inside isOccurrenceDue): a daemon that was down for a week
    // runs the last occurrence, not every one it missed.
    return isOccurrenceDue(this.cron, since, now);
  }

  /**
   * The fire never became work (the submission threw): the occurrence this
   * look consumed is due again on the next one.
   */
  onSubmitFailed(_now: Date): void {
    this.lastChecked = this.checkedBeforeLastLook;
    this.lastFired = null;
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
