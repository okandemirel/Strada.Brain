/**
 * Agent Core v2 — engine synthesis / result projection (relocation Step 4; blueprint:
 * project_v2_engine_relocation).
 *
 * The terminal-projection leaf of the port surface: project the terminal state + accumulated
 * effects into the structured AgentRunResult fields (provider/model/catalog, the touched-files
 * union, tool trace, verification/review, artifacts). Moved VERBATIM from orchestrator.ts. The
 * heavier synthesizeUserFacingResponse stays in the shell (synthesizeGoalExecutionResult, which
 * stays, calls it) — the port's synthesizeFinal is a pure read-back and needs no move here.
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — see engine-deps.ts.
 */

import type {
  WorkerVerificationResult,
  WorkerReviewFinding,
  WorkerArtifactMetadata,
  WorkspaceLease,
} from "../../agents/supervisor/supervisor-types.js";
import type { VerifierPipelineResult } from "../../agents/autonomy/index.js";
import type { ResultProjectionParams, AgentRunResultProjection } from "../runner/orchestrator-port.js";
import type { EngineRunContext } from "./engine-deps.js";

/** The dependency slice the projection reads (grows only with this module). */
export interface EngineProviderManager {
  getActiveInfo?: (identityKey: string) => { providerName?: string; model?: string } | undefined;
  getCatalogSnapshot?: (identityKey: string) => { assignmentVersion: number } | undefined;
  getProvider: (identityKey: string) => import("../../agents/providers/provider.interface.js").IAIProvider;
  listAvailable: () => Array<{ name: string; label?: string; defaultModel?: string }>;
  /** Step 7 (trimContextWindowForRun): provider-capability lookup for the context-window trim. */
  getProviderCapabilities?: (
    providerName: string,
    model?: string,
  ) => import("../../agents/providers/provider.interface.js").IAIProvider["capabilities"] | undefined;
}

export interface SynthesisDeps {
  readonly providerManager: EngineProviderManager;
}

export function toWorkerVerificationResults(
  result: VerifierPipelineResult | null | undefined,
): WorkerVerificationResult[] {
  if (!result) {
    return [];
  }

  return result.checks.map((check) => ({
    name: check.name,
    status: check.status,
    summary: check.summary,
  }));
}

export function toWorkerReviewFindings(
  result: VerifierPipelineResult | null | undefined,
): WorkerReviewFinding[] {
  if (!result) {
    return [];
  }

  const findings: WorkerReviewFinding[] = [];
  for (const check of result.checks) {
    if (check.status === "issues") {
      findings.push({
        source: check.name === "completion-review" ? "completion-review" : "integration",
        severity: check.gate ? "error" : "warning",
        message: check.summary,
      });
    }
  }

  const reviewDecision = result.reviewDecision;
  if (reviewDecision?.reviews) {
    const reviewSources: Array<{
      key: keyof NonNullable<typeof reviewDecision.reviews>;
      source: WorkerReviewFinding["source"];
    }> = [
      { key: "code", source: "code-review" },
      { key: "simplify", source: "simplify" },
      { key: "security", source: "security-review" },
    ];
    for (const reviewSource of reviewSources) {
      if (reviewDecision.reviews[reviewSource.key] === "issues") {
        findings.push({
          source: reviewSource.source,
          severity: "error",
          message: `${reviewSource.source} found issues during completion review.`,
        });
      }
    }
  }

  for (const finding of reviewDecision?.findings ?? []) {
    findings.push({
      source: "completion-review",
      severity: result.decision === "approve" ? "info" : "warning",
      message: finding,
    });
  }

  for (const stageResult of result.stageResults ?? []) {
    const source = stageResult.stage === "code"
      ? "code-review"
      : stageResult.stage === "simplify"
        ? "simplify"
        : "security-review";
    for (const finding of stageResult.findings ?? []) {
      findings.push({
        source,
        severity: stageResult.status === "issues" ? "warning" : "info",
        message: finding,
      });
    }
  }

  return findings;
}

export function buildWorkerArtifacts(params: {
  workspaceLease?: WorkspaceLease;
  workspaceLeaseRetained?: boolean;
  touchedFiles: readonly string[];
  finalSummary: string;
}): WorkerArtifactMetadata[] {
  const artifacts: WorkerArtifactMetadata[] = [];
  if (params.workspaceLease) {
    artifacts.push({
      kind: "workspace",
      summary: `Worker executed in isolated workspace ${params.workspaceLease.id}.`,
      ...(params.workspaceLeaseRetained !== false ? { path: params.workspaceLease.path } : {}),
    });
  }
  if (params.touchedFiles.length > 0) {
    artifacts.push({
      kind: "patch",
      summary: `Touched ${params.touchedFiles.length} file(s).`,
    });
  }
  artifacts.push({
    kind: "result",
    summary: params.finalSummary,
  });
  return artifacts;
}

export function buildResultProjection(
  deps: SynthesisDeps,
  params: ResultProjectionParams,
  runCtx: EngineRunContext,
): AgentRunResultProjection {
  const info = deps.providerManager.getActiveInfo?.(runCtx.identityKey);
  const snapshot = deps.providerManager.getCatalogSnapshot?.(runCtx.identityKey);
  const allTouchedFiles = [
    ...new Set([
      ...params.touchedFiles,
      ...runCtx.selfVerification.getState().touchedFiles,
      ...(runCtx.workerCollector?.childWorkerResults ?? []).flatMap((r) => r.touchedFiles ?? []),
    ]),
  ];
  return {
    provider: runCtx.lastAssignment?.providerName ?? info?.providerName ?? "unknown",
    model: runCtx.lastAssignment?.modelId ?? info?.model,
    // The catalog exposes only assignmentVersion; surface it as the catalog version string and
    // fall back to "unknown" when no snapshot getter exists (lightweight test providerManager).
    catalogVersion: snapshot ? String(snapshot.assignmentVersion) : "unknown",
    assignmentVersion: snapshot?.assignmentVersion ?? 0,
    // The spine accumulates the tool trace BY VALUE (params); the run collector exists only
    // for what the SHARED handlers write during the run — the verifier pipeline result —
    // which the projection reads back here (v1 parity: runWorkerTask's collector projection).
    workspaceId: runCtx.workspaceLease?.id, // v1 parity: runWorkerTask result.workspaceId
    // v1 parity (trio catch): union the spine's by-value trace files with selfVerification's
    // ingested state AND delegated child workers' touchedFiles — the deleted runWorkerTask
    // merged both (collector.touchedFiles = selfVerification state; child files unioned), so
    // a sub-agent's edits must keep surfacing in the parent's result + artifacts.
    touchedFiles: allTouchedFiles,
    toolTrace: params.toolTrace.map((t) => ({
      toolName: t.toolName,
      success: t.success,
      summary: "",
      timestamp: 0,
    })),
    verificationResults: toWorkerVerificationResults(runCtx.workerCollector?.verifierResult),
    reviewFindings: toWorkerReviewFindings(runCtx.workerCollector?.verifierResult),
    // v1 parity: buildWorkerArtifacts surfaces the workspace + touched-files + result summary.
    artifacts: buildWorkerArtifacts({
      workspaceLease: runCtx.workspaceLease,
      workspaceLeaseRetained: runCtx.workspaceLeaseRetained,
      touchedFiles: allTouchedFiles,
      finalSummary: params.final.summary,
    }),
  };
}
