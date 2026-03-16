/**
 * Build State Observer
 * Reports build success/failure state from the SelfVerification system.
 */

import { createObservation, type Observer, type AgentObservation } from "../observation-types.js";

/** Structural interface for SelfVerification state */
interface BuildStateRef {
  getState(): {
    pendingFiles: ReadonlySet<string>;
    hasCompilableChanges: boolean;
    lastBuildOk: boolean | null;
  };
}

export class BuildStateObserver implements Observer {
  readonly name = "build-state-observer";
  private lastReportedState: boolean | null = null;

  constructor(private readonly buildState: BuildStateRef) {}

  collect(): AgentObservation[] {
    const state = this.buildState.getState();

    // Only report on state changes
    if (state.lastBuildOk === this.lastReportedState) {
      return [];
    }

    this.lastReportedState = state.lastBuildOk;

    if (state.lastBuildOk === false) {
      const fileCount = state.pendingFiles.size;
      return [
        createObservation("build", `Build failed with ${fileCount} pending file(s)`, {
          priority: 85, // High priority — build failures should be addressed
          context: {
            pendingFiles: [...state.pendingFiles].slice(0, 10),
            hasCompilableChanges: state.hasCompilableChanges,
          },
        }),
      ];
    }

    if (state.lastBuildOk === true) {
      return [
        createObservation("build", "Build succeeded", {
          priority: 10,
          actionable: false, // Informational
        }),
      ];
    }

    return [];
  }
}
