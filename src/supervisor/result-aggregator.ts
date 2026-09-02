/**
 * ResultAggregator — Three-stage result pipeline: collect, verify, synthesize.
 *
 * Processes NodeResult[] from parallel supervisor execution into a unified
 * SupervisorResult with optional cross-provider verification.
 */

import type {
  NodeResult,
  VerificationConfig,
  VerificationReport,
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
  /** Nodes stopped by a control-plane abort — excluded from the success/failure gate. */
  readonly cancelled: NodeResult[];
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
    const cancelled: NodeResult[] = [];

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
        case "cancelled":
          cancelled.push(r);
          break;
      }
    }

    return { succeeded, failed, blocked, skipped, cancelled };
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Verify
  // ---------------------------------------------------------------------------

  /** Cross-validate results based on verification config mode. */
  async verify(results: NodeResult[]): Promise<NodeResult[]> {
    return (await this.verifyWithReport(results)).results;
  }

  /**
   * Cross-validate results and say what was measured.
   *
   * audited 2026-09-02: `verify` returned the array untouched when the mode was
   * disabled, no verifier was wired, the budget cut a node, or the sampler
   * skipped it — and the caller derived its verdict from "did any ok node get
   * downgraded", so zero verification was indistinguishable from a full pass.
   * The report carries the count of nodes a verifier actually judged.
   */
  async verifyWithReport(
    results: NodeResult[],
  ): Promise<{ results: NodeResult[]; report: VerificationReport }> {
    const { mode, samplingRate } = this.verificationConfig;
    const okResults = results.filter((r) => r.status === "ok");
    const counts = { approved: 0, flagged: 0, rejected: 0 };

    if (mode === "disabled" || !this.verifyFn) {
      return {
        results,
        report: {
          candidates: okResults.length,
          verified: 0,
          ...counts,
          notVerified: okResults.length,
        },
      };
    }

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

    // Run verification on selected nodes, cheapest first so the budget covers the
    // most nodes possible.
    const updatedResults = [...results];
    let verificationSpend = 0;
    const ordered = [...toVerify].sort((a, b) => Math.max(a.cost, 0) - Math.max(b.cost, 0));
    for (const node of ordered) {
      const estimatedVerificationCost = Math.max(node.cost, 0) * 0.1;
      const projectedSpend = verificationSpend + estimatedVerificationCost;
      if (
        Number.isFinite(this.verificationConfig.maxVerificationCost) &&
        projectedSpend > this.verificationConfig.maxVerificationCost
      ) {
        // Skip this node but keep checking the rest — `break` abandoned ALL
        // remaining verification after the first node that didn't fit the budget.
        continue;
      }
      verificationSpend = projectedSpend;
      const verdict = await this.verifyFn(node);

      if (verdict.verdict === "approve") {
        counts.approved++;
      } else if (verdict.verdict === "flag_issues") {
        counts.flagged++;
      } else if (verdict.verdict === "reject") {
        counts.rejected++;
      }

      if (verdict.verdict === "reject") {
        const idx = updatedResults.findIndex((result) => result.nodeId === node.nodeId);
        if (idx !== -1) {
          updatedResults[idx] = {
            ...updatedResults[idx]!,
            status: "failed",
            output: `Verification rejected: ${verdict.issues?.join(", ") ?? "no details"}`,
          };
        }
      } else if (verdict.verdict === "flag_issues" && (verdict.issues?.length ?? 0) > 0) {
        // Flags used to be dropped on the floor: the node stayed "ok" and the
        // issues reached nobody — including the "no verifier available" and
        // "verifier returned prose" cases, which thereby passed as verified.
        // The node still passes, but the flags travel with its output so
        // synthesis and any later review see what was never established.
        const idx = updatedResults.findIndex((result) => result.nodeId === node.nodeId);
        if (idx !== -1) {
          const flagged = updatedResults[idx]!;
          updatedResults[idx] = {
            ...flagged,
            output:
              `${flagged.output}\n\n[VERIFIER FLAGS — unresolved; this node was NOT positively verified]\n` +
              verdict.issues!.map((issue) => `- ${issue}`).join("\n"),
          };
        }
      }
    }

    const verified = counts.approved + counts.flagged + counts.rejected;
    return {
      results: updatedResults,
      report: {
        candidates: okResults.length,
        verified,
        ...counts,
        notVerified: okResults.length - verified,
      },
    };
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
    const { succeeded, failed, blocked, skipped, cancelled } = this.collect(results);
    const totalNodes = results.length;
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const totalDuration = results.reduce((max, r) => Math.max(max, r.duration), 0);

    // Full success: all ok
    if (failed.length === 0 && blocked.length === 0 && skipped.length === 0 && cancelled.length === 0) {
      const output = succeeded.map((r) => r.output).join("\n\n");
      return {
        success: true,
        partial: false,
        output,
        totalNodes,
        succeeded: succeeded.length,
        failed: 0,
        blocked: blocked.length,
        skipped: 0,
        totalCost,
        totalDuration,
        nodeResults: results,
      };
    }

    // Success-with-cancellations: no failures or blocks, but some nodes were
    // cancelled by a control-plane abort (e.g. a benign sibling winddown). Cancelled
    // nodes are excluded from the failure gate so they do NOT downgrade an otherwise
    // -successful task to blocked/failed (audit #13).
    if (failed.length === 0 && blocked.length === 0 && skipped.length === 0 && cancelled.length > 0) {
      const output = succeeded.map((r) => r.output).join("\n\n");
      return {
        success: true,
        partial: true,
        output,
        totalNodes,
        succeeded: succeeded.length,
        failed: 0,
        blocked: blocked.length,
        skipped: 0,
        totalCost,
        totalDuration,
        nodeResults: results,
      };
    }

    // Total failure: every node ran and failed. audited 2026-09-02: this fired on
    // "no successes, nothing blocked" alone, so an all-skipped run (failure
    // budget 0) said "All nodes failed:" over an EMPTY list with failed:0, and
    // 3 failed + 1 skipped said "All nodes failed" while listing 3 of 4. Runs
    // with skipped or cancelled nodes fall through to the sectioned output,
    // whose headline is built from the actual tallies.
    if (
      succeeded.length === 0 &&
      blocked.length === 0 &&
      failed.length > 0 &&
      skipped.length === 0 &&
      cancelled.length === 0
    ) {
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
        blocked: blocked.length,
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
    // Carry the reason the dispatcher recorded ("Skipped: budget exhausted" vs
    // "Skipped: dependency failed") — it used to render as the bare word
    // "skipped", so a run the failure budget stopped was indistinguishable from
    // one whose dependencies collapsed (audited 2026-09-02).
    const skippedList = skipped.map((r) => `[${r.nodeId}] ${r.output || "skipped"}`).join("\n");

    if (succeeded.length === 0 && blocked.length === 0) {
      sections.push(
        `No node succeeded: ${failed.length} failed, ${skipped.length} skipped, ${cancelled.length} cancelled.`,
      );
    }
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
      blocked: blocked.length,
      skipped: skipped.length,
      totalCost,
      totalDuration,
      nodeResults: results,
    };
  }
}
