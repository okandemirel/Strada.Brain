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
  /**
   * What was last reported: the build state AND, for a failure, whether it was actionable.
   * Latching on the build state alone meant a failure first seen as non-actionable (nothing
   * pending, or the guardian owning it) was never re-reported once it became actionable.
   */
  private lastReportedKey: string | null = null;

  /**
   * @param repairOwnedElsewhere True while another subsystem owns repairing
   *   this build — today, the real-tree guardian.
   *
   *   Measured in a live campaign: the guardian and a queue of AgentCore
   *   "investigate the build failure" tasks both repaired the same project
   *   tree, and each one's half-finished edits became the other's new error
   *   list. The error count oscillated instead of converging, and no
   *   convergence guard could bite, because the guard counts one owner's
   *   rounds while several agents share the tree. With a single owner the
   *   tree converged within minutes.
   */
  constructor(
    private readonly buildState: BuildStateRef,
    private readonly repairOwnedElsewhere: () => boolean = () => false,
  ) {}

  collect(): AgentObservation[] {
    const state = this.buildState.getState();
    const ownedElsewhere = state.lastBuildOk === false && this.repairOwnedElsewhere();
    const fileCount = state.pendingFiles.size;
    const key =
      state.lastBuildOk === null ? "unknown"
      : state.lastBuildOk ? "ok"
      : ownedElsewhere ? "failed:owned"
      : fileCount === 0 ? "failed:nothing-pending"
      : "failed:actionable";

    // Only report on state changes
    if (key === this.lastReportedKey) {
      return [];
    }

    this.lastReportedKey = key;

    if (state.lastBuildOk === false) {
      // A FAILURE WITH NOTHING PENDING NAMES NOTHING TO FIX. Measured in a
      // live campaign: raised at priority 85, each such observation became a
      // task telling an agent to "investigate the current build failure … and
      // rerun the build" with no file to look at, and those agents went looking
      // for something to repair and edited the project instead. The state is
      // still reported — it is real — but it is not actionable work until
      // something names what broke.
      if (ownedElsewhere) {
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
