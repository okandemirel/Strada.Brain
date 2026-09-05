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

  /**
   * @param repairOwnedElsewhere True while another subsystem owns repairing
   *   this build — today, the real-tree guardian.
   *
   *   Measured live 2026-09-04/05: the guardian and a queue of AgentCore
   *   "investigate the build failure" tasks both repaired the SAME Unity tree,
   *   and each one's half-finished edits became the other's new error list.
   *   The compile-error count oscillated between 4 and 40 for eight hours and
   *   no convergence guard could bite, because the guard counts one owner's
   *   rounds while six agents share the tree. With one owner it went 26 → 2 in
   *   ten minutes.
   */
  constructor(
    private readonly buildState: BuildStateRef,
    private readonly repairOwnedElsewhere: () => boolean = () => false,
  ) {}

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
      if (this.repairOwnedElsewhere()) {
        return [
          createObservation(
            "build",
            `Build failed with ${fileCount} pending file(s) — the real-tree guardian owns this repair, so it is not work for anyone else`,
            { priority: 20, actionable: false, context: { pendingFiles: [...state.pendingFiles].slice(0, 10) } },
          ),
        ];
      }
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
