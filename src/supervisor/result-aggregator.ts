/**
 * ResultAggregator — Three-stage result pipeline: collect, verify, synthesize.
 *
 * Processes NodeResult[] from parallel supervisor execution into a unified
 * SupervisorResult with optional cross-provider verification.
 */

import type {
  NodeResult,
  VerificationConfig,
  VerificationVerdict,
  SupervisorResult,
} from "./supervisor-types.js";

// =============================================================================
// COLLECTED RESULTS
// =============================================================================

/** Categorized node results from the collect stage */
export interface CollectedResults {
  readonly succeeded: NodeResult[];
  readonly failed: NodeResult[];
  readonly blocked: NodeResult[];
  readonly skipped: NodeResult[];
}

// =============================================================================
// RESULT AGGREGATOR
// =============================================================================

export class ResultAggregator {
  private readonly verificationConfig: VerificationConfig;
  private readonly verifyFn?: (node: NodeResult) => Promise<VerificationVerdict>;

  constructor(
    verificationConfig: VerificationConfig,
    verifyFn?: (node: NodeResult) => Promise<VerificationVerdict>,
  ) {
    this.verificationConfig = verificationConfig;
    this.verifyFn = verifyFn;
  }

  // ---------------------------------------------------------------------------
  // Stage 1: Collect
  // ---------------------------------------------------------------------------

  /** Categorize results by status into succeeded / failed / skipped buckets. */
  collect(results: NodeResult[]): CollectedResults {
    const succeeded: NodeResult[] = [];
    const failed: NodeResult[] = [];
    const blocked: NodeResult[] = [];
    const skipped: NodeResult[] = [];

    for (const r of results) {
      switch (r.status) {
        case "ok":
          succeeded.push(r);
          break;
        case "failed":
          if (r.blockedReason) {
            blocked.push(r);
          } else {
            failed.push(r);
          }
          break;
        case "skipped":
          skipped.push(r);
          break;
      }
    }

    return { succeeded, failed, blocked, skipped };
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Verify
  // ---------------------------------------------------------------------------

  /** Cross-validate results based on verification config mode. */
  async verify(results: NodeResult[]): Promise<NodeResult[]> {
    const { mode, samplingRate } = this.verificationConfig;

    if (mode === "disabled" || !this.verifyFn) {
      return results;
    }

    const okResults = results.filter((r) => r.status === "ok");
    const otherResults = results.filter((r) => r.status !== "ok");

    let toVerify: NodeResult[];

    switch (mode) {
      case "always":
        toVerify = okResults;
        break;

      case "critical-only":
        // Verify nodes that have a quality preference (indicated by capabilityProfile on tagged nodes)
        // Since NodeResult doesn't carry capability profile, verify all ok nodes in critical-only
        // The caller is responsible for filtering to critical nodes before passing
        toVerify = okResults;
        break;

      case "sampling": {
        const rate = Math.max(0, Math.min(1, samplingRate));
        toVerify = okResults.filter(() => Math.random() < rate);
        break;
      }

      default:
        toVerify = [];
    }

    // Run verification on selected nodes
    const verifiedSet = new Set<string>();
    for (const node of toVerify) {
      const verdict = await this.verifyFn(node);
      verifiedSet.add(node.nodeId);

      if (verdict.verdict === "reject") {
        // Mark rejected nodes as failed
        const idx = results.indexOf(node);
        if (idx !== -1) {
          const failedNode: NodeResult = {
            ...node,
            status: "failed",
            output: `Verification rejected: ${verdict.issues?.join(", ") ?? "no details"}`,
          };
          return [
            ...otherResults,
            ...okResults.map((r) => (r === node ? failedNode : r)),
          ];
        }
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Conflict Detection
  // ---------------------------------------------------------------------------

  /** Find file paths that appear in artifacts of multiple ok nodes. */
  detectConflicts(results: NodeResult[]): string[] {
    const okResults = results.filter((r) => r.status === "ok");
    const pathCounts = new Map<string, number>();

    for (const result of okResults) {
      for (const artifact of result.artifacts) {
        pathCounts.set(artifact.path, (pathCounts.get(artifact.path) ?? 0) + 1);
      }
    }

    const conflicts: string[] = [];
    for (const [path, count] of pathCounts) {
      if (count > 1) {
        conflicts.push(path);
      }
    }

    return conflicts;
  }

  // ---------------------------------------------------------------------------
  // Stage 3: Synthesize
  // ---------------------------------------------------------------------------

  /** Generate a SupervisorResult from collected node results. */
  synthesize(results: NodeResult[]): SupervisorResult {
    const { succeeded, failed, blocked, skipped } = this.collect(results);
    const totalNodes = results.length;
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const totalDuration = results.reduce((max, r) => Math.max(max, r.duration), 0);

    // Full success: all ok
    if (failed.length === 0 && blocked.length === 0 && skipped.length === 0) {
      const output = succeeded.map((r) => r.output).join("\n\n");
      return {
        success: true,
        partial: false,
        output,
        totalNodes,
        succeeded: succeeded.length,
        failed: 0,
        skipped: 0,
        totalCost,
        totalDuration,
        nodeResults: results,
      };
    }

    // Total failure: all failed (no successes)
    if (succeeded.length === 0 && blocked.length === 0) {
      const failureDetails = failed
        .map((r) => `[${r.nodeId}] ${r.output}`)
        .join("\n");
      return {
        success: false,
        partial: false,
        output: `All nodes failed:\n${failureDetails}`,
        totalNodes,
        succeeded: 0,
        failed: failed.length,
        skipped: skipped.length,
        totalCost,
        totalDuration,
        nodeResults: results,
      };
    }

    const sections: string[] = [];
    const completedWork = succeeded.map((r) => r.output).join("\n\n");
    const blockedList = blocked
      .map((r) => `[${r.nodeId}] ${r.blockedReason ?? r.output}`)
      .join("\n");
    const failureList = failed.map((r) => `[${r.nodeId}] ${r.output}`).join("\n");
    const skippedList = skipped.map((r) => `[${r.nodeId}] skipped`).join("\n");

    if (completedWork) {
      sections.push(`Completed:\n${completedWork}`);
    }
    if (blockedList) {
      sections.push(`Blocked:\n${blockedList}`);
    }
    if (failureList) {
      sections.push(`Failed:\n${failureList}`);
    }
    if (skippedList) {
      sections.push(`Skipped:\n${skippedList}`);
    }

    return {
      success: false,
      partial: succeeded.length > 0 || blocked.length > 0,
      output: sections.join("\n\n"),
      totalNodes,
      succeeded: succeeded.length,
      failed: failed.length + blocked.length,
      skipped: skipped.length,
      totalCost,
      totalDuration,
      nodeResults: results,
    };
  }
}
