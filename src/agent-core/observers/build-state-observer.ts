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
      // A FAILURE WITH NOTHING PENDING NAMES NOTHING TO FIX. Measured live
      // 2026-09-05: "Build failed with 0 pending file(s)" was raised nine
      // times at priority 85, and each one became a task telling an agent to
      // "investigate the current build failure … and rerun the build" with no
      // file to look at. Those agents went looking for something to repair and
      // edited the Unity project instead. The state is still reported — it is
      // real — but it is not actionable work until something names what broke.
      if (fileCount === 0) {
        return [
          createObservation(
            "build",
            "Build state is failed, but no files are pending — nothing names what broke, so there is nothing to fix here",
            {
              priority: 20,
              actionable: false,
              context: { hasCompilableChanges: state.hasCompilableChanges },
            },
          ),
        ];
      }
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
