import type { TaskClassification } from "../../agent-core/routing/routing-types.js";
import type { WorkspaceLease as ManagedWorkspaceLease, WorkspaceLeaseKind } from "../multi/workspace-lease-manager.js";

export interface ProviderCatalogSnapshot {
  readonly provider: string;
  readonly model?: string;
  readonly freshness: number;
  readonly officialAlignment: number;
  readonly stale: boolean;
  readonly updatedAt?: number;
  readonly degraded: boolean;
  readonly version: string;
}

export interface ProviderRoutingDecision {
  readonly provider: string;
  readonly model?: string;
  readonly task: TaskClassification;
  readonly reason: string;
  readonly assignmentVersion: number;
  readonly timestamp: number;
  readonly identityKey?: string;
  readonly catalog: ProviderCatalogSnapshot;
}

export type WorkspaceLeaseMode = WorkspaceLeaseKind;
export type WorkspaceLease = ManagedWorkspaceLease;

export interface WorkerToolTrace {
  readonly toolName: string;
  readonly success: boolean;
  readonly summary: string;
  readonly timestamp: number;
  readonly workspaceId?: string;
}

export interface WorkerVerificationResult {
  readonly name: string;
  readonly status: "clean" | "issues" | "not_applicable";
  readonly summary: string;
}

export interface WorkerReviewFinding {
  readonly source:
    | "code-review"
    | "simplify"
    | "security-review"
    | "integration"
    | "completion-review";
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
}

export interface WorkerArtifactMetadata {
  readonly kind: "workspace" | "patch" | "result";
  readonly summary: string;
  readonly path?: string;
}

export interface WorkerRunRequest {
  readonly prompt: string;
  readonly mode: "interactive" | "background" | "delegated";
  readonly chatId: string;
  readonly channelType?: string;
  readonly conversationId?: string;
  readonly userId?: string;
  readonly taskRunId?: string;
  readonly workspaceLease?: WorkspaceLease;
}

export type WorkerRunStatus = "completed" | "failed" | "blocked";

export interface WorkerRunResult {
  readonly status: WorkerRunStatus;
  readonly finalSummary: string;
  readonly visibleResponse: string;
  readonly provider: string;
  readonly model?: string;
  readonly catalogVersion: string;
  readonly assignmentVersion: number;
  readonly workspaceId?: string;
  readonly touchedFiles: readonly string[];
  readonly toolTrace: readonly WorkerToolTrace[];
  readonly verificationResults: readonly WorkerVerificationResult[];
  readonly reviewFindings: readonly WorkerReviewFinding[];
  readonly artifacts: readonly WorkerArtifactMetadata[];
  readonly reason?: string;
}

export interface IntegrationResult {
  readonly applied: boolean;
  readonly workspaceId?: string;
  readonly summary: string;
  readonly touchedFiles: readonly string[];
  readonly conflicts: readonly string[];
}

export function createCatalogVersion(snapshot: {
  provider: string;
  model?: string;
  updatedAt?: number;
  stale: boolean;
  degraded: boolean;
}): string {
  return [
    snapshot.provider,
    snapshot.model ?? "default",
    snapshot.updatedAt ?? "unknown",
    snapshot.stale ? "stale" : "fresh",
    snapshot.degraded ? "degraded" : "healthy",
  ].join(":");
}
