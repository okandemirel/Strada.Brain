/**
 * User Activity Observer
 * Reports user idle/active state changes as observations.
 * The agent should prefer acting when the user is idle.
 */

import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

export class UserActivityObserver implements Observer {
  readonly name = "user-activity-observer";
  private lastActivityMs = Date.now();
  private wasIdle = false;
  private readonly idleThresholdMs: number;

  constructor(idleThresholdMs = 5 * 60_000) {
    this.idleThresholdMs = idleThresholdMs;
  }

  /** Called externally when user sends a message or interacts */
  recordActivity(): void {
    this.lastActivityMs = Date.now();
  }

  collect(): AgentObservation[] {
    const now = Date.now();
    const idleMs = now - this.lastActivityMs;
    const isIdle = idleMs >= this.idleThresholdMs;

    // Only report state changes
    if (isIdle && !this.wasIdle) {
      this.wasIdle = true;
      const minutes = Math.round(idleMs / 60_000);
      return [
        createObservation("user", `User idle for ${minutes} minutes`, {
          priority: 20,
          context: { idleMs, lastActivityMs: this.lastActivityMs },
          actionable: false, // Informational — agent uses this for timing decisions
        }),
      ];
    }

    if (!isIdle && this.wasIdle) {
      this.wasIdle = false;
      return [
        createObservation("user", "User returned (active)", {
          priority: 15,
          context: { idleMs: 0 },
          actionable: false,
        }),
      ];
    }

    return [];
  }
}
