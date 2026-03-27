/**
 * Intervention Pipeline — Standalone functions extracted from Orchestrator.
 *
 * Phase 3 of orchestrator restructuring.
 * Consolidates the clarification -> visibility -> verifier -> loop recovery
 * intervention chain behind a shared InterventionDeps context interface.
 *
 * Pure helpers (no deps needed):
 *   selectLoopRecoveryDelegationTool, isNovelLoopRecoveryAction,
 *   buildLoopRecoveryGate, buildLoopRecoveryCheckpointMessage
 *
 * Complex intervention functions (use InterventionDeps):
 *   resolveLoopRecoveryReview, handleBackgroundLoopRecovery,
 *   resolveVerifierIntervention, reviewClarification,
 *   resolveDraftClarificationIntervention, resolveVisibleDraftDecision
 */

import type { AgentState } from "./agent-state.js";
import type {
  ToolCall,
  ToolResult,
  ProviderResponse,
  ConversationMessage,
} from "./providers/provider.interface.js";
import type {
  SupervisorAssignment,
  SupervisorExecutionStrategy,
} from "./orchestrator-supervisor-routing.js";
import {
  canInspectLocally as canInspectLocallyHelper,
  decideUserVisibleBoundary as decideUserVisibleBoundaryHelper,
  resolveDraftClarificationIntervention as resolveDraftClarificationInterventionHelper,
  type ClarificationContext,
  type ClarificationIntervention,
} from "./orchestrator-clarification.js";
import type {
  CompletionReviewStageResult,
} from "./autonomy/completion-review.js";
import type {
  LoopRecoveryBrief,
  LoopRecoveryReviewDecision,
} from "./autonomy/loop-recovery-review.js";
import type { VerifierPipelineResult } from "./autonomy/verifier-pipeline.js";
import type {
  TaskClassification,
  VerifierDecision,
} from "../agent-core/routing/routing-types.js";
import type { TaskProgressSignal, TaskProgressUpdate, TaskUsageEvent } from "../tasks/types.js";
import type { ProgressLanguage } from "../tasks/progress-signals.js";
import type {
  WorkspaceLease,
  WorkerRunResult,
  WorkerToolTrace,
} from "./supervisor/supervisor-types.js";
import { planVerifierPipeline } from "./autonomy/verifier-pipeline.js";
import { parseCompletionReviewDecision } from "./autonomy/completion-review.js";
import {
  LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT,
  buildLoopRecoveryReviewRequest,
  parseLoopRecoveryReviewDecision,
  sanitizeLoopRecoveryReviewDecision,
  CLARIFICATION_REVIEW_SYSTEM_PROMPT,
  buildClarificationReviewRequest,
  collectClarificationReviewEvidence,
  parseClarificationReviewDecision,
  sanitizeClarificationReviewDecision,
  shouldRunClarificationReview,
  decideInteractionBoundary,
  isTerminalFailureReport,
  finalizeVerifierPipelineReview,
  buildVisibilityReviewGate,
  sanitizeVisibilityReviewDecision,
  shouldRunVisibilityReview,
  userExplicitlyAskedForPlan,
  draftLooksLikeInternalPlanArtifact,
  type ControlLoopTracker,
  type ExecutionJournal,
  type SelfVerification,
  type ControlLoopGateKind,
  type InteractionBoundaryDecision,
  computeAdaptiveHardCap,
} from "./autonomy/index.js";
import { isVerificationToolName } from "./autonomy/constants.js";
import type { StradaConformanceGuard } from "./autonomy/strada-conformance.js";
import {
  buildBehavioralSnapshot,
  runProgressAssessment,
  buildDirectiveGate,
  buildStuckCheckpointMessage,
} from "./autonomy/progress-assessment.js";
import { shouldDeferRawBoundaryForDirectTarget } from "./prompt-targets.js";
import type { Session } from "./orchestrator-session-manager.js";
import { toPhaseOutcomeStatus as toPhaseOutcomeStatusModel } from "./orchestrator-phase-telemetry.js";
import { getLogger, type LogEntry } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerifierIntervention {
  kind: "approve" | "continue" | "replan";
  gate?: string;
  result: VerifierPipelineResult;
}

export interface LoopRecoveryIntervention {
  action: "none" | "continue" | "replan" | "blocked";
  gate?: string;
  message?: string;
  summary?: string;
}

// ─── ToolExecutionOptions (mirrored from orchestrator.ts local type) ──────────

type ToolExecutionMode = "interactive" | "background" | "delegated";

export interface ToolExecutionOptions {
  mode?: ToolExecutionMode;
  userId?: string;
  taskPrompt?: string;
  sessionMessages?: ConversationMessage[];
  onUsage?: (usage: TaskUsageEvent) => void;
  identityKey?: string;
  strategy?: SupervisorExecutionStrategy;
  agentState?: AgentState;
  touchedFiles?: readonly string[];
  projectPathOverride?: string;
  workingDirectoryOverride?: string;
  workspaceLease?: WorkspaceLease;
}

// ─── InterventionDeps ─────────────────────────────────────────────────────────

/**
 * Shared dependency interface carrying orchestrator capabilities as callbacks.
 * Created once per loop invocation and passed to all intervention functions.
 */
export interface InterventionDeps {
  // Provider routing
  readonly getReviewerAssignment: (
    identityKey: string,
    strategy?: SupervisorExecutionStrategy,
  ) => SupervisorAssignment;
  readonly classifyTask: (prompt: string) => TaskClassification;
  readonly buildSupervisorRolePrompt: (
    strategy: SupervisorExecutionStrategy,
    assignment: SupervisorAssignment,
  ) => string;
  readonly systemPrompt: string;
  readonly projectPath?: string;

  // Clarification context
  readonly clarificationContext: ClarificationContext;
  readonly stripInternalDecisionMarkers: (text: string | null | undefined) => string;
  readonly interactionPolicy: {
    requirePlanReview(chatId: string, reason: string, planText: string): void;
  };
  readonly formatPlanReviewMessage: (draft: string) => string;

  // Telemetry
  readonly recordExecutionTrace: (params: {
    chatId: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: string;
    source: string;
    task: TaskClassification;
  }) => void;
  readonly recordAuxiliaryUsage: (
    providerName: string,
    usage: ProviderResponse["usage"],
    handler?: (usage: TaskUsageEvent) => void,
  ) => void;
  readonly recordPhaseOutcome: (params: {
    chatId: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: string;
    source: string;
    status: string;
    task: TaskClassification;
    reason: string;
    telemetry?: unknown;
  }) => void;
  readonly buildPhaseOutcomeTelemetry: (params: {
    state?: AgentState;
    usage?: ProviderResponse["usage"];
    verifierDecision?: VerifierDecision;
    failureReason?: string | null;
    projectWorldFingerprint?: string;
  }) => unknown;
  readonly recordRuntimeArtifactEvaluation: (params: {
    chatId: string;
    taskRunId?: string;
    decision: string;
    summary: string;
    failureReason?: string | null;
  }) => void;
  readonly getTaskRunId: () => string | undefined;

  // Execution capabilities (callbacks to orchestrator)
  readonly synthesizeUserFacingResponse: (params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    agentState: AgentState;
    strategy: SupervisorExecutionStrategy;
    systemPrompt: string;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }) => Promise<string>;
  readonly runCompletionReviewStages: (params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    state: AgentState;
    draft: string;
    plan: ReturnType<typeof planVerifierPipeline>;
    strategy: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }) => Promise<{
    decision: ReturnType<typeof parseCompletionReviewDecision>;
    stageResults: CompletionReviewStageResult[];
    usage?: ProviderResponse["usage"];
  }>;
  readonly runVisibilityReview: (params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    evidence: ReturnType<typeof planVerifierPipeline>["evidence"];
    task: TaskClassification;
    strategy: SupervisorExecutionStrategy;
    canInspectLocally: boolean;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }) => Promise<{
    decision: ReturnType<typeof sanitizeVisibilityReviewDecision>;
    usage?: ProviderResponse["usage"];
  }>;
  // Matches actual signature: (chatId, toolCalls, options?) -- NOT object params
  readonly executeToolCalls: (
    chatId: string,
    toolCalls: ToolCall[],
    options?: ToolExecutionOptions,
  ) => Promise<ToolResult[]>;
  readonly getLogRingBuffer: () => LogEntry[];

  // Progress signaling (used by handleBackgroundLoopRecovery)
  readonly buildStructuredProgressSignal: (
    prompt: string,
    title: string,
    signal: Omit<TaskProgressSignal, "userSummary"> & { userSummary?: string },
    language?: ProgressLanguage,
  ) => TaskProgressSignal;
}

// ─── Pure Helper Functions ────────────────────────────────────────────────────

function toVerifierInterventionKind(
  decision: string,
): VerifierIntervention["kind"] {
  if (decision === "replan") return "replan";
  if (decision === "continue") return "continue";
  return "approve";
}

function toClarificationReviewStatus(
  decision: string | undefined,
): string {
  if (decision === "ask_user" || decision === "blocked") return "blocked";
  if (decision === "internal_continue") return "continued";
  return "approved";
}

export function selectLoopRecoveryDelegationTool(
  availableToolNames: readonly string[] | undefined,
  touchedFiles: readonly string[],
): "delegate_analysis" | "delegate_code_review" | null {
  if (!availableToolNames || availableToolNames.length === 0) {
    return null;
  }
  if (touchedFiles.length > 0 && availableToolNames.includes("delegate_code_review")) {
    return "delegate_code_review";
  }
  if (availableToolNames.includes("delegate_analysis")) {
    return "delegate_analysis";
  }
  if (availableToolNames.includes("delegate_code_review")) {
    return "delegate_code_review";
  }
  return null;
}

export function isNovelLoopRecoveryAction(
  decision: LoopRecoveryReviewDecision,
  brief: LoopRecoveryBrief,
): boolean {
  const action = decision.recommendedNextAction?.trim().toLowerCase();
  if (!action) {
    return false;
  }
  if (brief.requiredActions.some((item) => item.toLowerCase() === action)) {
    return false;
  }
  if (brief.recentToolSummaries.some((item) => item.toLowerCase().includes(action))) {
    return false;
  }
  return true;
}

export function buildLoopRecoveryGate(params: {
  brief: LoopRecoveryBrief;
  decision: LoopRecoveryReviewDecision;
  delegatedSummary?: string;
}): string {
  const lines = [
    "[LOOP RECOVERY REQUIRED]",
    "",
    `Loop fingerprint: ${params.brief.fingerprint}`,
    `Reason: ${params.decision.reason ?? params.brief.latestReason ?? "Repeated internal review loop detected."}`,
  ];
  if (params.delegatedSummary) {
    lines.push(`Delegated diagnosis: ${params.delegatedSummary}`);
  }
  if (params.brief.requiredActions.length > 0) {
    lines.push("Required verifier actions:");
    for (const action of params.brief.requiredActions.slice(0, 4)) {
      lines.push(`- ${action}`);
    }
  }
  if (params.decision.recommendedNextAction) {
    lines.push(`Next action: ${params.decision.recommendedNextAction}`);
  }
  lines.push("Do not repeat the same fingerprint without materially new evidence.");
  return lines.join("\n");
}

function shouldPreserveBlockedDecisionInDaemonMode(kind: ControlLoopGateKind): boolean {
  switch (kind) {
    case "clarification_internal_continue":
    case "visibility_internal_continue":
    case "verifier_continue":
      return true;
    default:
      return false;
  }
}

export function buildLoopRecoveryCheckpointMessage(params: {
  prompt: string;
  brief: LoopRecoveryBrief;
  decision: LoopRecoveryReviewDecision;
  touchedFiles: readonly string[];
}): string {
  const title = params.prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Task checkpoint";
  const touched = params.touchedFiles.slice(0, 5).map((file) => `- ${file}`);
  const progress = params.brief.recentUserFacingProgress.slice(-3).map((line) => `- ${line}`);
  return [
    `Blocked checkpoint: ${title}`,
    "",
    `Reason: ${params.decision.reason ?? params.brief.latestReason ?? "Repeated internal review loop detected."}`,
    params.brief.verifierSummary ? `Verifier: ${params.brief.verifierSummary}` : "",
    progress.length > 0 ? `Recent progress:\n${progress.join("\n")}` : "",
    touched.length > 0 ? `Touched files:\n${touched.join("\n")}` : "",
    "Stopped here to avoid growing the same control loop again.",
  ].filter(Boolean).join("\n\n");
}

function buildProgressAssessmentDelegationDecision(
  toolName: "delegate_analysis" | "delegate_code_review",
  assessment: import("./autonomy/progress-assessment.js").ProgressAssessment,
  touchedFiles: readonly string[],
): DelegationLoopRecoveryDecision {
  const stuckReason =
    `Progress assessment marked the worker as stuck (${assessment.confidence} confidence).`;
  const directive = assessment.directive?.trim();
  if (toolName === "delegate_code_review") {
    return {
      decision: toolName,
      reason: directive ? `${stuckReason} ${directive}`.slice(0, 220) : stuckReason,
      recommendedNextAction: directive,
      delegationTask: [
        "Review the touched files and identify the concrete change needed to break the current analysis loop.",
        directive ? `Progress assessment directive: ${directive}` : "",
        `Touched files:\n${touchedFiles.join("\n") || "(none)"}`,
      ].filter(Boolean).join("\n\n"),
      summary: directive ? `Delegated code review after stuck assessment: ${directive}` : "Delegated code review after stuck assessment.",
    };
  }

  return {
    decision: toolName,
    reason: directive ? `${stuckReason} ${directive}`.slice(0, 220) : stuckReason,
    recommendedNextAction: directive,
    delegationTask: [
      "Analyze why the primary worker is repeating analysis/clarification instead of executing tools.",
      directive ? `Progress assessment directive: ${directive}` : "",
      "Return the next concrete tool-driven action that should happen now.",
    ].filter(Boolean).join("\n\n"),
    summary: directive ? `Delegated loop analysis after stuck assessment: ${directive}` : "Delegated loop analysis after stuck assessment.",
  };
}

function buildImmediateDelegationDecision(params: {
  toolName: "delegate_analysis" | "delegate_code_review";
  reason: string;
  summary: string;
  recommendedNextAction?: string;
  touchedFiles: readonly string[];
}): DelegationLoopRecoveryDecision {
  if (params.toolName === "delegate_code_review") {
    return {
      decision: params.toolName,
      reason: params.reason,
      recommendedNextAction: params.recommendedNextAction,
      delegationTask: [
        "Review the touched files and identify the exact code-level change needed to break the current control loop.",
        params.recommendedNextAction ? `Suggested next action: ${params.recommendedNextAction}` : "",
        `Touched files:\n${params.touchedFiles.join("\n") || "(none)"}`,
      ].filter(Boolean).join("\n\n"),
      summary: params.summary,
    };
  }

  return {
    decision: params.toolName,
    reason: params.reason,
    recommendedNextAction: params.recommendedNextAction,
    delegationTask: [
      "Analyze why the current worker is still stuck in a text-only loop and return the exact next tool-backed move.",
      params.recommendedNextAction ? `Suggested next action: ${params.recommendedNextAction}` : "",
    ].filter(Boolean).join("\n\n"),
    summary: params.summary,
  };
}

async function executeLoopRecoveryDelegation(
  params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    title: string;
    language?: ProgressLanguage;
    state: AgentState;
    strategy: SupervisorExecutionStrategy;
    availableToolNames?: readonly string[];
    selfVerification: SelfVerification;
    executionJournal: ExecutionJournal;
    usageHandler?: (usage: TaskUsageEvent) => void;
    onProgress: (message: TaskProgressUpdate) => void;
    session: Session;
    workerCollector?: WorkerRunCollector;
    workspaceLease?: WorkspaceLease;
  },
  deps: InterventionDeps,
  options: {
    brief: LoopRecoveryBrief;
    touchedFiles: readonly string[];
    decision: DelegationLoopRecoveryDecision;
    reviewRequestOptions?: {
      daemonMode?: boolean;
      maxRecoveryEpisodes?: number;
    };
  },
): Promise<LoopRecoveryIntervention | null> {
  const toolName = options.decision.decision;
  if (!params.availableToolNames?.includes(toolName)) {
    return null;
  }

  params.onProgress(
    deps.buildStructuredProgressSignal(
      params.prompt,
      params.title,
      {
        kind: "delegation",
        message: `Loop recovery delegation: ${toolName}`,
        delegationType: toolName.replace(/^delegate_/, ""),
        files: options.touchedFiles,
      },
      params.language,
    ),
  );

  const delegatedTask =
    options.decision.delegationTask
    ?? (
      toolName === "delegate_code_review"
        ? `Review the touched files and identify why the current verification loop is not closing cleanly.\nTouched files:\n${options.touchedFiles.join("\n") || "(none)"}`
        : `Analyze the repeated control loop and identify the missing evidence or verification path.\nFingerprint: ${options.brief.fingerprint}\nVerifier memory: ${options.brief.verifierSummary ?? "(none)"}`
    );
  const toolCall: ToolCall = {
    id: `loop-recovery-${randomUUID()}`,
    name: toolName,
    input: {
      task: delegatedTask,
      context: buildLoopRecoveryReviewRequest(options.brief, options.reviewRequestOptions),
      mode: "sync",
    },
  };
  const toolResults = await deps.executeToolCalls(params.chatId, [toolCall], {
    mode: "background",
    taskPrompt: params.prompt,
    sessionMessages: params.session.messages,
    onUsage: params.usageHandler,
    identityKey: params.identityKey,
    strategy: params.strategy,
    agentState: params.state,
    touchedFiles: options.touchedFiles,
    workspaceLease: params.workspaceLease,
  });
  const toolResult = toolResults[0];
  const delegatedWorkerResult = toolResult?.metadata?.["workerResult"] as WorkerRunResult | undefined;
  if (toolResult) {
    params.workerCollector?.toolTrace.push({
      toolName: toolCall.name,
      success: !(toolResult.isError ?? false),
      summary: toolResult.content.slice(0, 200),
      timestamp: Date.now(),
      workspaceId: params.workspaceLease?.id,
    });
  }
  if (delegatedWorkerResult) {
    params.selfVerification.ingestWorkerResult(delegatedWorkerResult);
    params.workerCollector?.childWorkerResults.push(delegatedWorkerResult);
  }
  params.executionJournal.recordDelegatedDiagnosis(
    toolName.replace(/^delegate_/, ""),
    toolResult?.content ?? delegatedWorkerResult?.finalSummary ?? "",
  );
  params.executionJournal.recordLoopRecoveryEpisode({
    fingerprint: options.brief.fingerprint,
    decision: options.decision.decision,
    summary: options.decision.reason ?? "Delegated diagnosis requested.",
  });
  return {
    action: "replan",
    gate: buildLoopRecoveryGate({
      brief: options.brief,
      decision: options.decision,
      delegatedSummary:
        delegatedWorkerResult?.finalSummary
        ?? toolResult?.content
        ?? options.decision.summary,
    }),
    summary: delegatedWorkerResult?.finalSummary ?? toolResult?.content ?? options.decision.summary,
  };
}

// ─── WorkerRunCollector (mirrored from orchestrator.ts local type) ────────────

export interface WorkerRunCollector {
  toolTrace: WorkerToolTrace[];
  childWorkerResults: WorkerRunResult[];
  verifierResult?: VerifierPipelineResult;
  touchedFiles?: readonly string[];
  finalVisibleResponse?: string;
  finalSummary?: string;
  lastAssignment?: SupervisorAssignment;
  status?: WorkerRunResult["status"];
  reason?: string;
}

type DelegationLoopRecoveryDecision = LoopRecoveryReviewDecision & {
  decision: "delegate_analysis" | "delegate_code_review";
};

// ─── Complex Intervention Functions (use InterventionDeps) ────────────────────

/**
 * Sends the loop-recovery brief to the reviewer provider and returns
 * a structured decision (continue / replan / delegate / blocked).
 */
export async function resolveLoopRecoveryReview(
  params: {
    chatId: string;
    identityKey: string;
    brief: LoopRecoveryBrief;
    strategy: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
    daemonMode?: boolean;
    maxRecoveryEpisodes?: number;
  },
  deps: InterventionDeps,
): Promise<LoopRecoveryReviewDecision> {
  const reviewer = params.strategy.reviewer;
  try {
    const response = await reviewer.provider.chat(
      LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT,
      [
        {
          role: "user",
          content: buildLoopRecoveryReviewRequest(params.brief, {
            daemonMode: params.daemonMode,
            maxRecoveryEpisodes: params.maxRecoveryEpisodes,
          }),
        },
      ],
      [],
    );
    deps.recordAuxiliaryUsage(reviewer.providerName, response.usage, params.usageHandler);
    return sanitizeLoopRecoveryReviewDecision(
      parseLoopRecoveryReviewDecision(response.text),
    ) ?? { decision: "replan_local", reason: "Loop recovery review returned no usable decision." };
  } catch (error) {
    getLogger().warn("Loop recovery review provider failed", {
      chatId: params.chatId,
      provider: reviewer.providerName,
      error: error instanceof Error ? error.message : String(error),
    });
    return { decision: "replan_local", reason: "Loop recovery review failed; falling back to local replanning." };
  }
}

/**
 * Full background loop-recovery pipeline: detects repeated control-loop
 * patterns, delegates diagnosis when possible, and returns an intervention
 * decision (none / continue / replan / blocked).
 */
export async function handleBackgroundLoopRecovery(
  params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    title: string;
    language?: ProgressLanguage;
    state: AgentState;
    strategy: SupervisorExecutionStrategy;
    tracker: ControlLoopTracker;
    executionJournal: ExecutionJournal;
    kind: ControlLoopGateKind;
    reason?: string;
    gate?: string;
    iteration: number;
    availableToolNames?: readonly string[];
    selfVerification: SelfVerification;
    usageHandler?: (usage: TaskUsageEvent) => void;
    onProgress: (message: TaskProgressUpdate) => void;
    session: Session;
    workerCollector?: WorkerRunCollector;
    workspaceLease?: WorkspaceLease;
    daemonMode?: boolean;
    maxRecoveryEpisodes?: number;
    progressAssessmentEnabled?: boolean;
    taskStartedAtMs?: number;
  },
  deps: InterventionDeps,
): Promise<LoopRecoveryIntervention> {
  // ─── Progress Assessment (primary defense) ──────────────────────────────────
  // Compute gate count without double-incrementing: recordGate() already
  // increments consecutiveNoToolGates, so we read the CURRENT value + 1
  // to predict what it will be after the next recordGate() call.
  const gateCount = params.tracker.getConsecutiveTextOnlyGates() + 1;

  // Adaptive hard cap: thresholds adjust based on agent phase and progress.
  // Planning/reflecting after tool use gets more headroom; executing with zero
  // tools gets the tightest detection. Base values come from config.
  const { replan: hardCapReplan, block: hardCapBlock } = computeAdaptiveHardCap(
    params.tracker.hardCapReplan,
    params.tracker.hardCapBlock,
    {
      phase: params.state.phase,
      totalStepCount: params.state.stepResults.length,
      hasActivePlan: params.state.plan !== null,
      failedApproachCount: params.state.failedApproaches.length,
    },
  );

  if (gateCount >= hardCapBlock) {
    const fingerprint = `hard_cap_block:${params.kind}`;
    const touchedFiles = [...params.selfVerification.getState().touchedFiles];
    const hardCapDelegationTool = selectLoopRecoveryDelegationTool(
      params.availableToolNames,
      touchedFiles,
    );
    const recoveryAttempt = params.tracker.markRecoveryAttempt(fingerprint);
    const hardCapSummary = `Hard cap reached: ${gateCount} consecutive text-only gates without any tool execution.`;
    if (hardCapDelegationTool && recoveryAttempt < 2) {
      const brief = params.executionJournal.buildRecoveryBrief({
        fingerprint,
        latestReason: hardCapSummary,
        touchedFiles,
        recoveryEpisode: recoveryAttempt,
        availableDelegations: [hardCapDelegationTool],
      });
      const delegatedIntervention = await executeLoopRecoveryDelegation({
        chatId: params.chatId,
        identityKey: params.identityKey,
        prompt: params.prompt,
        title: params.title,
        language: params.language,
        state: params.state,
        strategy: params.strategy,
        availableToolNames: params.availableToolNames,
        selfVerification: params.selfVerification,
        executionJournal: params.executionJournal,
        usageHandler: params.usageHandler,
        onProgress: params.onProgress,
        session: params.session,
        workerCollector: params.workerCollector,
        workspaceLease: params.workspaceLease,
      }, deps, {
        brief,
        touchedFiles,
        decision: buildImmediateDelegationDecision({
          toolName: hardCapDelegationTool,
          reason: hardCapSummary,
          summary: "Hard-cap loop recovery delegated for immediate diagnosis.",
          recommendedNextAction: "Identify the exact tool-backed move required to break the text-only loop now.",
          touchedFiles,
        }),
        reviewRequestOptions: {
          daemonMode: params.daemonMode,
          maxRecoveryEpisodes: params.maxRecoveryEpisodes,
        },
      });
      if (delegatedIntervention) {
        return delegatedIntervention;
      }
    }
    params.executionJournal.recordLoopRecoveryEpisode({
      fingerprint,
      decision: "blocked",
      summary: hardCapSummary,
    });
    return {
      action: "blocked",
      message:
        `Blocked checkpoint: The agent has produced ${gateCount} consecutive text-only responses ` +
        "without executing any tools. No implementation work has started despite clear required changes. " +
        "Stopped to avoid wasting further iterations.",
    };
  }

  if (gateCount >= hardCapReplan) {
    const fingerprint = `hard_cap_replan:${params.kind}`;
    const touchedFiles = [...params.selfVerification.getState().touchedFiles];
    const hardCapDelegationTool = selectLoopRecoveryDelegationTool(
      params.availableToolNames,
      touchedFiles,
    );
    const recoveryAttempt = params.tracker.markRecoveryAttempt(fingerprint);
    const hardCapSummary = `Hard cap replan: ${gateCount} consecutive text-only gates.`;
    if (hardCapDelegationTool && recoveryAttempt < 2) {
      const brief = params.executionJournal.buildRecoveryBrief({
        fingerprint,
        latestReason: hardCapSummary,
        touchedFiles,
        recoveryEpisode: recoveryAttempt,
        availableDelegations: [hardCapDelegationTool],
      });
      const delegatedIntervention = await executeLoopRecoveryDelegation({
        chatId: params.chatId,
        identityKey: params.identityKey,
        prompt: params.prompt,
        title: params.title,
        language: params.language,
        state: params.state,
        strategy: params.strategy,
        availableToolNames: params.availableToolNames,
        selfVerification: params.selfVerification,
        executionJournal: params.executionJournal,
        usageHandler: params.usageHandler,
        onProgress: params.onProgress,
        session: params.session,
        workerCollector: params.workerCollector,
        workspaceLease: params.workspaceLease,
      }, deps, {
        brief,
        touchedFiles,
        decision: buildImmediateDelegationDecision({
          toolName: hardCapDelegationTool,
          reason: hardCapSummary,
          summary: "Hard-cap replan delegated for immediate diagnosis.",
          recommendedNextAction: "Identify the next concrete tool call or code change required to make progress.",
          touchedFiles,
        }),
        reviewRequestOptions: {
          daemonMode: params.daemonMode,
          maxRecoveryEpisodes: params.maxRecoveryEpisodes,
        },
      });
      if (delegatedIntervention) {
        return delegatedIntervention;
      }
    }
    params.executionJournal.recordLoopRecoveryEpisode({
      fingerprint,
      decision: recoveryAttempt >= 2 ? "blocked" : "replan_local",
      summary: hardCapSummary,
    });
    if (recoveryAttempt >= 2) {
      return {
        action: "blocked",
        message:
          `Blocked checkpoint: After ${gateCount} consecutive text-only responses and multiple replan attempts, ` +
          "the agent has not been able to start tool execution. Stopped to prevent infinite loop.",
      };
    }
    return {
      action: "replan",
      gate: [
        `[HARD CAP] You have produced ${gateCount} consecutive text-only responses without using any tools.`,
        "STOP analyzing and START implementing immediately. Use your available tools to make concrete progress.",
        "Your next response MUST contain tool calls. Do not generate another text-only response.",
      ].join("\n\n"),
    };
  }

  // Free first analysis — agent may be legitimately exploring.
  // Record the gate (which increments the counter) and return.
  if (gateCount <= 1) {
    params.tracker.recordGate({
      kind: params.kind,
      reason: params.reason,
      gate: params.gate,
      iteration: params.iteration,
    });
    return { action: "none" };
  }

  // Run LLM-based progress assessment (haiku-tier)
  if (params.progressAssessmentEnabled !== false) {
    try {
      const touchedFilesForSnapshot = [...params.selfVerification.getState().touchedFiles];
      const snapshot = buildBehavioralSnapshot({
        prompt: params.prompt,
        state: params.state,
        touchedFileCount: touchedFilesForSnapshot.length,
        consecutiveTextOnlyGates: gateCount,
        taskStartedAtMs: params.taskStartedAtMs ?? Date.now(),
        draftExcerpt: (params.gate ?? params.reason ?? "").slice(0, 200),
      });
      const assessment = await runProgressAssessment(
        snapshot,
        params.strategy.reviewer as Parameters<typeof runProgressAssessment>[1],
        {
          recordAuxiliaryUsage: deps.recordAuxiliaryUsage as Parameters<typeof runProgressAssessment>[2]["recordAuxiliaryUsage"],
          usageHandler: params.usageHandler,
        },
      );

      if (assessment) {
        if (assessment.verdict === "progressing") {
          // Record gate for safety-net tracking.
          // IMPORTANT: check the trigger — if the safety net fires,
          // do NOT trust the progress assessment.
          const progressingTrigger = params.tracker.recordGate({
            kind: params.kind,
            reason: params.reason,
            gate: params.gate,
            iteration: params.iteration,
          });
          if (progressingTrigger && progressingTrigger.reason === "stale_analysis_loop") {
            // Safety net overrides "progressing" — the agent has hit the
            // stale analysis threshold despite claiming progress.
            const touchedFiles = [...params.selfVerification.getState().touchedFiles];
            const delegationTool = selectLoopRecoveryDelegationTool(
              params.availableToolNames,
              touchedFiles,
            );
            const staleRecovery = params.tracker.markRecoveryAttempt(progressingTrigger.fingerprint);
            const staleSummary =
              `Stale analysis override: progress assessment said "progressing" but ${progressingTrigger.sameFingerprintCount} consecutive text-only gates detected.`;
            if (delegationTool && staleRecovery < 2) {
              const brief = params.executionJournal.buildRecoveryBrief({
                fingerprint: progressingTrigger.fingerprint,
                latestReason: staleSummary,
                touchedFiles,
                recoveryEpisode: staleRecovery,
                availableDelegations: [delegationTool],
              });
              const delegatedIntervention = await executeLoopRecoveryDelegation({
                chatId: params.chatId,
                identityKey: params.identityKey,
                prompt: params.prompt,
                title: params.title,
                language: params.language,
                state: params.state,
                strategy: params.strategy,
                availableToolNames: params.availableToolNames,
                selfVerification: params.selfVerification,
                executionJournal: params.executionJournal,
                usageHandler: params.usageHandler,
                onProgress: params.onProgress,
                session: params.session,
                workerCollector: params.workerCollector,
                workspaceLease: params.workspaceLease,
              }, deps, {
                brief,
                touchedFiles,
                decision: buildImmediateDelegationDecision({
                  toolName: delegationTool,
                  reason: staleSummary,
                  summary: "Stale-analysis override delegated for immediate diagnosis.",
                  recommendedNextAction: "Identify the exact missing tool execution path and break the loop now.",
                  touchedFiles,
                }),
                reviewRequestOptions: {
                  daemonMode: params.daemonMode,
                  maxRecoveryEpisodes: params.maxRecoveryEpisodes,
                },
              });
              if (delegatedIntervention) {
                return delegatedIntervention;
              }
            }
            params.executionJournal.recordLoopRecoveryEpisode({
              fingerprint: progressingTrigger.fingerprint,
              decision: staleRecovery >= 2 ? "blocked" : "replan_local",
              summary: staleSummary,
            });
            if (staleRecovery >= 2) {
              return {
                action: "blocked",
                message:
                  `Blocked checkpoint: Despite claiming progress, the agent has produced ${progressingTrigger.sameFingerprintCount} ` +
                  "consecutive text-only responses without any tool execution. Stopped to prevent infinite loop.",
              };
            }
            return {
              action: "replan",
              gate: [
                "[STALE ANALYSIS OVERRIDE] Progress assessment said 'progressing' but you have NOT used any tools.",
                "STOP analyzing and START implementing. Use your available tools to make concrete progress.",
                "Your next response MUST contain tool calls.",
              ].join("\n\n"),
            };
          }
          return { action: "none" };
        }
        if (assessment.verdict === "stuck" && assessment.confidence !== "low") {
          // Agent is stuck — act without recording gate
          const fingerprint = `progress_assessment_stuck:${params.kind}`;
          const touchedFiles = [...params.selfVerification.getState().touchedFiles];
          const assessmentDelegationTool = selectLoopRecoveryDelegationTool(
            params.availableToolNames,
            touchedFiles,
          );
          const recoveryAttempt = params.tracker.markRecoveryAttempt(fingerprint);
          const hardBlockRecoveryEpisode = Math.max(2, params.maxRecoveryEpisodes ?? 5);
          const assessmentSummary =
            `Progress assessment: ${assessment.verdict} (${assessment.confidence}). ${assessment.directive ?? ""}`.trim();
          if (recoveryAttempt >= hardBlockRecoveryEpisode) {
            params.executionJournal.recordLoopRecoveryEpisode({
              fingerprint,
              decision: "blocked",
              summary: assessmentSummary,
            });
            return {
              action: "blocked",
              message: buildStuckCheckpointMessage(
                params.prompt,
                assessment,
                touchedFiles,
              ),
            };
          }
          if (assessmentDelegationTool) {
            const brief = params.executionJournal.buildRecoveryBrief({
              fingerprint,
              latestReason: assessmentSummary,
              touchedFiles,
              recoveryEpisode: recoveryAttempt,
              availableDelegations: [assessmentDelegationTool],
            });
            const delegatedIntervention = await executeLoopRecoveryDelegation({
              chatId: params.chatId,
              identityKey: params.identityKey,
              prompt: params.prompt,
              title: params.title,
              language: params.language,
              state: params.state,
              strategy: params.strategy,
              availableToolNames: params.availableToolNames,
              selfVerification: params.selfVerification,
              executionJournal: params.executionJournal,
              usageHandler: params.usageHandler,
              onProgress: params.onProgress,
              session: params.session,
              workerCollector: params.workerCollector,
              workspaceLease: params.workspaceLease,
            }, deps, {
              brief,
              touchedFiles,
              decision: buildProgressAssessmentDelegationDecision(
                assessmentDelegationTool,
                assessment,
                touchedFiles,
              ),
            });
            if (delegatedIntervention) {
              return delegatedIntervention;
            }
          }
          params.executionJournal.recordLoopRecoveryEpisode({
            fingerprint,
            decision: "replan_local",
            summary: assessmentSummary,
          });
          return {
            action: "replan",
            gate: buildDirectiveGate(assessment),
          };
        }
        // stuck + low confidence → fall through to safety net
      }
      // assessment is null (parse error / timeout) → fall through to safety net
    } catch {
      // Non-fatal: progress assessment failure falls through to safety net
    }
  }

  // ─── Safety Net: existing ControlLoopTracker logic ──────────────────────────
  const touchedFiles = [...params.selfVerification.getState().touchedFiles];
  const recoveryDelegationTool = selectLoopRecoveryDelegationTool(
    params.availableToolNames,
    touchedFiles,
  );
  const trigger = params.tracker.recordGate({
    kind: params.kind,
    reason: params.reason,
    gate: params.gate,
    iteration: params.iteration,
  });
  if (!trigger) {
    return { action: "none" };
  }

  // Stale analysis loop: agent is stuck generating text without tool execution.
  // Force blocked immediately on second trigger to prevent wasting iterations.
  if (trigger.reason === "stale_analysis_loop") {
    const staleRecovery = params.tracker.markRecoveryAttempt(trigger.fingerprint);
    const staleMsg =
      "Blocked checkpoint: The agent has been generating analysis/clarification text " +
      `without executing any tools for ${trigger.sameFingerprintCount} consecutive turns. ` +
      "No implementation work has started despite clear required changes.";
    if (recoveryDelegationTool && staleRecovery < 2) {
      const staleBrief = params.executionJournal.buildRecoveryBrief({
        fingerprint: trigger.fingerprint,
        latestReason: staleMsg,
        touchedFiles,
        recoveryEpisode: staleRecovery,
        availableDelegations: [recoveryDelegationTool],
      });
      const delegatedIntervention = await executeLoopRecoveryDelegation({
        chatId: params.chatId,
        identityKey: params.identityKey,
        prompt: params.prompt,
        title: params.title,
        language: params.language,
        state: params.state,
        strategy: params.strategy,
        availableToolNames: params.availableToolNames,
        selfVerification: params.selfVerification,
        executionJournal: params.executionJournal,
        usageHandler: params.usageHandler,
        onProgress: params.onProgress,
        session: params.session,
        workerCollector: params.workerCollector,
        workspaceLease: params.workspaceLease,
      }, deps, {
        brief: staleBrief,
        touchedFiles,
        decision: buildImmediateDelegationDecision({
          toolName: recoveryDelegationTool,
          reason: staleMsg,
          summary: "Stale-analysis recovery delegated for immediate diagnosis.",
          recommendedNextAction: "Identify the missing tool execution path and break the text-only loop now.",
          touchedFiles,
        }),
        reviewRequestOptions: {
          daemonMode: params.daemonMode,
          maxRecoveryEpisodes: params.maxRecoveryEpisodes,
        },
      });
      if (delegatedIntervention) {
        return delegatedIntervention;
      }
    }
    params.executionJournal.recordLoopRecoveryEpisode({
      fingerprint: trigger.fingerprint,
      decision: staleRecovery >= 2 ? "blocked" : "replan_local",
      summary: staleMsg,
    });
    if (staleRecovery >= 2) {
      return {
        action: "blocked",
        message: buildLoopRecoveryCheckpointMessage({
          prompt: params.prompt,
          brief: params.executionJournal.buildRecoveryBrief({
            fingerprint: trigger.fingerprint,
            latestReason: trigger.latestReason,
            touchedFiles,
            recoveryEpisode: staleRecovery,
            availableDelegations: [],
          }),
          decision: { decision: "blocked", reason: staleMsg },
          touchedFiles,
        }),
      };
    }
    return {
      action: "replan",
      gate: [
        "[STALE ANALYSIS DETECTED] You have been generating text-only analysis without using any tools.",
        "STOP analyzing and START implementing. Use your available tools (file_read, file_write, shell, etc.) to make concrete progress.",
        "Do not generate another analysis response. Execute tool calls in your next response.",
      ].join("\n\n"),
    };
  }

  const brief = params.executionJournal.buildRecoveryBrief({
    fingerprint: trigger.fingerprint,
    latestReason: trigger.latestReason,
    touchedFiles,
    recoveryEpisode: trigger.recoveryEpisode + 1,
    availableDelegations: recoveryDelegationTool ? [recoveryDelegationTool] : [],
  });
  const reviewDecision = await resolveLoopRecoveryReview({
    chatId: params.chatId,
    identityKey: params.identityKey,
    brief,
    strategy: params.strategy,
    usageHandler: params.usageHandler,
    daemonMode: params.daemonMode,
    maxRecoveryEpisodes: params.maxRecoveryEpisodes,
  }, deps);
  const recoveryAttempt = params.tracker.markRecoveryAttempt(trigger.fingerprint);

  let finalDecision = reviewDecision;
  if (recoveryAttempt >= 2) {
    finalDecision = {
      decision: "blocked",
      reason: reviewDecision.reason ?? "Repeated control-loop recovery attempts did not produce a clean path.",
      summary: reviewDecision.summary,
    };
  } else if (recoveryAttempt >= 1 && recoveryDelegationTool) {
    finalDecision = {
      ...reviewDecision,
      decision:
        recoveryDelegationTool === "delegate_code_review"
          ? "delegate_code_review"
          : "delegate_analysis",
    };
  } else if (reviewDecision.decision === "continue_local" && !isNovelLoopRecoveryAction(reviewDecision, brief)) {
    finalDecision = {
      ...reviewDecision,
      decision: "replan_local",
      reason: reviewDecision.reason ?? "Suggested next action was not materially different from the repeated loop.",
    };
  }

  if (finalDecision.decision === "delegate_analysis" || finalDecision.decision === "delegate_code_review") {
    const delegationDecision = finalDecision as DelegationLoopRecoveryDecision;
    const delegatedIntervention = await executeLoopRecoveryDelegation({
      chatId: params.chatId,
      identityKey: params.identityKey,
      prompt: params.prompt,
      title: params.title,
      language: params.language,
      state: params.state,
      strategy: params.strategy,
      availableToolNames: params.availableToolNames,
      selfVerification: params.selfVerification,
      executionJournal: params.executionJournal,
      usageHandler: params.usageHandler,
      onProgress: params.onProgress,
      session: params.session,
      workerCollector: params.workerCollector,
      workspaceLease: params.workspaceLease,
    }, deps, {
      brief,
      touchedFiles,
      decision: delegationDecision,
      reviewRequestOptions: {
        daemonMode: params.daemonMode,
        maxRecoveryEpisodes: params.maxRecoveryEpisodes,
      },
    });
    if (delegatedIntervention) {
      return delegatedIntervention;
    }
    finalDecision = {
      ...finalDecision,
      decision: "replan_local",
      reason: finalDecision.reason ?? "Delegation was requested but not available; falling back to local replanning.",
    };
  }

  params.executionJournal.recordLoopRecoveryEpisode({
    fingerprint: brief.fingerprint,
    decision: finalDecision.decision ?? "replan_local",
    summary: finalDecision.reason ?? "Loop recovery requested a different path.",
  });

  // Daemon/autonomous mode: convert "blocked" to "replan_local" unless truly exhausted
  if (
    finalDecision.decision === "blocked" &&
    params.daemonMode &&
    brief.recoveryEpisode < (params.maxRecoveryEpisodes ?? 5) &&
    !shouldPreserveBlockedDecisionInDaemonMode(params.kind)
  ) {
    finalDecision = {
      ...finalDecision,
      decision: "replan_local",
      reason: `${finalDecision.reason ?? "blocked"} [daemon override: converting to replan]`,
    };
  }

  if (finalDecision.decision === "blocked") {
    return {
      action: "blocked",
      message: buildLoopRecoveryCheckpointMessage({
        prompt: params.prompt,
        brief,
        decision: finalDecision,
        touchedFiles,
      }),
    };
  }

  if (finalDecision.decision === "continue_local") {
    return {
      action: "continue",
      gate: buildLoopRecoveryGate({
        brief,
        decision: finalDecision,
      }),
    };
  }

  return {
    action: "replan",
    gate: buildLoopRecoveryGate({
      brief,
      decision: finalDecision,
    }),
  };
}

/**
 * Runs the full verifier pipeline: plans checks, evaluates the interaction
 * boundary, optionally calls the completion-review provider, and returns
 * an approve / continue / replan decision.
 */
export async function resolveVerifierIntervention(
  params: {
    chatId: string;
    identityKey: string;
    executionMode: "interactive" | "background";
    prompt: string;
    state: AgentState;
    draft: string | null | undefined;
    selfVerification: SelfVerification;
    stradaConformance: StradaConformanceGuard;
    strategy: SupervisorExecutionStrategy;
    taskStartedAtMs: number;
    availableToolNames?: readonly string[];
    usageHandler?: (usage: TaskUsageEvent) => void;
  },
  deps: InterventionDeps,
): Promise<VerifierIntervention> {
  const verificationState = params.selfVerification.getState();
  const logEntries = deps.getLogRingBuffer();
  const buildVerificationGate = params.selfVerification.needsVerification()
    ? params.selfVerification.getPrompt()
    : null;
  const conformanceGate = params.stradaConformance.getPrompt();
  const hasExplicitVerifyTools = params.availableToolNames
    ? params.availableToolNames.some(t => isVerificationToolName(t))
    : false;
  const buildToolsAvailable = verificationState.hasCompilableChanges
    ? hasExplicitVerifyTools
    : params.availableToolNames
      ? hasExplicitVerifyTools || params.availableToolNames.some(t => t === "shell_exec")
      : true;
  const plan = planVerifierPipeline({
    prompt: params.prompt,
    draft: params.draft ?? "",
    state: params.state,
    task: params.strategy.task,
    verificationState,
    buildVerificationGate,
    conformanceGate,
    logEntries,
    chatId: params.chatId,
    taskStartedAtMs: params.taskStartedAtMs,
    buildToolsAvailable,
  });
  const boundaryDecision = decideInteractionBoundary({
    prompt: params.prompt,
    workerDraft: params.draft ?? "",
    visibleDraft: "",
    task: params.strategy.task,
    evidence: plan.evidence,
    canInspectLocally: canInspectLocallyHelper(
      deps.clarificationContext,
      params.prompt,
      params.strategy.task,
      params.availableToolNames ?? [],
    ),
    terminalFailureReported: isTerminalFailureReport(params.draft ?? ""),
    availableToolNames: params.availableToolNames,
  });
  if (
    boundaryDecision.kind === "internal_continue"
    && boundaryDecision.gate
    && !shouldDeferRawBoundaryForDirectTarget({
      prompt: params.prompt,
      touchedFileCount: plan.evidence.touchedFiles.length,
      hasCompilableChanges: verificationState.hasCompilableChanges,
    })
  ) {
    deps.recordRuntimeArtifactEvaluation({
      chatId: params.chatId,
      taskRunId: deps.getTaskRunId(),
      decision: "continue",
      summary: "The current draft still deflects execution back to the user.",
      failureReason: params.draft,
    });
    return {
      kind: "continue",
      gate: boundaryDecision.gate,
      result: {
        decision: "continue",
        gate: boundaryDecision.gate,
        summary: "The current draft still deflects execution back to the user.",
        checks: plan.checks,
        evidence: plan.evidence,
      },
    };
  }

  const canInspectLocally = canInspectLocallyHelper(
    deps.clarificationContext,
    params.prompt,
    params.strategy.task,
    params.availableToolNames ?? [],
  );

  const runVisibilityReviewGate = async (): Promise<{
    kind: "continue";
    gate: string;
    result: {
      decision: "continue";
      gate: string;
      summary: string;
      checks: typeof plan.checks;
      evidence: typeof plan.evidence;
    };
  } | null> => {
    if (
      params.executionMode !== "background"
      || boundaryDecision.kind !== "final_answer"
      || !shouldRunVisibilityReview({
        draft: boundaryDecision.visibleText ?? params.draft ?? "",
        evidence: plan.evidence,
        task: params.strategy.task,
        canInspectLocally,
      })
    ) {
      return null;
    }

    try {
      const visibilityReview = await deps.runVisibilityReview({
        chatId: params.chatId,
        identityKey: params.identityKey,
        prompt: params.prompt,
        draft: boundaryDecision.visibleText ?? params.draft ?? "",
        evidence: plan.evidence,
        task: params.strategy.task,
        strategy: params.strategy,
        canInspectLocally,
        usageHandler: params.usageHandler,
      });

      if (visibilityReview.decision?.decision !== "internal_continue") {
        return null;
      }

      const gate = buildVisibilityReviewGate(visibilityReview.decision, plan.evidence);
      deps.recordRuntimeArtifactEvaluation({
        chatId: params.chatId,
        taskRunId: deps.getTaskRunId(),
        decision: "continue",
        summary: visibilityReview.decision.reason ?? "Visibility review kept the draft internal.",
        failureReason: params.draft,
      });
      return {
        kind: "continue",
        gate,
        result: {
          decision: "continue",
          gate,
          summary: visibilityReview.decision.reason ?? "Visibility review kept the draft internal.",
          checks: plan.checks,
          evidence: plan.evidence,
        },
      };
    } catch (error) {
      getLogger().warn("Visibility review provider failed", {
        chatId: params.chatId,
        provider: params.strategy.reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  if (!plan.reviewRequired) {
    if (plan.initialDecision === "approve") {
      const visibilityGate = await runVisibilityReviewGate();
      if (visibilityGate) {
        return visibilityGate;
      }
    }
    deps.recordRuntimeArtifactEvaluation({
      chatId: params.chatId,
      taskRunId: deps.getTaskRunId(),
      decision: plan.initialDecision,
      summary: plan.summary,
      failureReason: params.draft,
    });
    return {
      kind: toVerifierInterventionKind(plan.initialDecision),
      gate: plan.gate,
      result: {
        decision: plan.initialDecision,
        gate: plan.gate,
        summary: plan.summary,
        checks: plan.checks,
        evidence: plan.evidence,
      },
    };
  }

  try {
    const stagedReview = await deps.runCompletionReviewStages({
      chatId: params.chatId,
      identityKey: params.identityKey,
      prompt: params.prompt,
      state: params.state,
      draft: params.draft ?? "",
      plan,
      strategy: params.strategy,
      usageHandler: params.usageHandler,
    });
    const result = finalizeVerifierPipelineReview(
      plan,
      stagedReview.decision,
      params.draft,
      stagedReview.stageResults,
    );
    deps.recordPhaseOutcome({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: params.strategy.reviewer,
      phase: "completion-review",
      source: "completion-review",
      status: toPhaseOutcomeStatusModel(result.decision),
      task: params.strategy.task,
      reason: result.summary,
      telemetry: deps.buildPhaseOutcomeTelemetry({
        usage: stagedReview.usage,
        verifierDecision: result.decision,
        state: params.state,
        failureReason: params.draft,
      }),
    });
    if (result.decision === "approve") {
      const visibilityGate = await runVisibilityReviewGate();
      if (visibilityGate) {
        return visibilityGate;
      }
    }
    deps.recordRuntimeArtifactEvaluation({
      chatId: params.chatId,
      taskRunId: deps.getTaskRunId(),
      decision: result.decision,
      summary: result.summary,
      failureReason: params.draft,
    });
    return {
      kind: toVerifierInterventionKind(result.decision),
      gate: result.gate,
      result,
    };
  } catch (error) {
    getLogger().warn("Completion review provider failed", {
      chatId: params.chatId,
      provider: params.strategy.reviewer.providerName,
      error: error instanceof Error ? error.message : String(error),
    });
    deps.recordPhaseOutcome({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: params.strategy.reviewer,
      phase: "completion-review",
      source: "completion-review",
      status: "failed",
      task: params.strategy.task,
      reason: "Completion review provider failed; falling back to conservative verifier gate.",
      telemetry: deps.buildPhaseOutcomeTelemetry({
        state: params.state,
        failureReason: params.draft,
      }),
    });
  }

  const fallbackResult = finalizeVerifierPipelineReview(plan, null, params.draft);
  deps.recordRuntimeArtifactEvaluation({
    chatId: params.chatId,
    taskRunId: deps.getTaskRunId(),
    decision: fallbackResult.decision,
    summary: fallbackResult.summary,
    failureReason: params.draft,
  });
  return {
    kind: toVerifierInterventionKind(fallbackResult.decision),
    gate: fallbackResult.gate,
    result: fallbackResult,
  };
}

/**
 * Sends the draft clarification to the reviewer provider and returns
 * a structured decision about whether to surface the clarification
 * to the user or keep it internal.
 */
export async function reviewClarification(
  params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    state: AgentState;
    touchedFiles?: readonly string[];
    strategy?: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
  },
  deps: InterventionDeps,
): Promise<{
  decision: ReturnType<typeof sanitizeClarificationReviewDecision>;
  evidence: ReturnType<typeof collectClarificationReviewEvidence>;
}> {
  const evidence = collectClarificationReviewEvidence({
    prompt: params.prompt,
    draft: params.draft,
    state: params.state,
    projectPath: deps.projectPath ?? "",
    touchedFiles: params.touchedFiles,
  });
  const reviewer = deps.getReviewerAssignment(params.identityKey, params.strategy);
  const reviewTask = params.strategy?.task ?? deps.classifyTask(params.prompt);
  const reviewStrategy = params.strategy ?? {
    task: reviewTask,
    planner: reviewer,
    executor: reviewer,
    reviewer,
    synthesizer: reviewer,
    usesMultipleProviders: false,
  };

  try {
    const reviewResponse = await reviewer.provider.chat(
      `${deps.systemPrompt}\n\n${CLARIFICATION_REVIEW_SYSTEM_PROMPT}${deps.buildSupervisorRolePrompt(reviewStrategy, reviewer)}`,
      [
        {
          role: "user",
          content: buildClarificationReviewRequest(evidence),
        },
      ],
      [],
    );
    deps.recordExecutionTrace({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: reviewer,
      phase: "clarification-review",
      source: "clarification-review",
      task: reviewTask,
    });
    deps.recordAuxiliaryUsage(reviewer.providerName, reviewResponse.usage, params.usageHandler);
    const decision = sanitizeClarificationReviewDecision(
      parseClarificationReviewDecision(reviewResponse.text),
    );
    deps.recordPhaseOutcome({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: reviewer,
      phase: "clarification-review",
      source: "clarification-review",
      status: toClarificationReviewStatus(decision?.decision),
      task: reviewTask,
      reason: decision?.reason ?? "Clarification review completed.",
      telemetry: deps.buildPhaseOutcomeTelemetry({
        usage: reviewResponse.usage,
      }),
    });
    return { decision, evidence };
  } catch (error) {
    getLogger().warn("Clarification review provider failed", {
      chatId: params.chatId,
      provider: reviewer.providerName,
      error: error instanceof Error ? error.message : String(error),
    });
    deps.recordPhaseOutcome({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: reviewer,
      phase: "clarification-review",
      source: "clarification-review",
      status: "failed",
      task: reviewTask,
      reason: "Clarification review provider failed; falling back to Strada-side decision.",
      telemetry: deps.buildPhaseOutcomeTelemetry({
        failureReason: params.draft,
      }),
    });
  }

  return {
    decision: evidence.canInspectLocally
      ? {
          decision: "internal_continue",
          reason: "Strada still has a local inspection path and should continue internally.",
          recommendedNextAction:
            "Inspect local files, logs, tests, or runtime state before asking the user anything else.",
        }
      : {
          decision: "blocked",
          reason:
            "External clarification is still required because no local inspection path remains.",
          blockingType: "missing_external_info",
          question: "Please share the missing external detail needed to continue.",
        },
    evidence,
  };
}

/**
 * Cleans the draft, checks if clarification review is needed, calls
 * reviewClarification, and returns a ClarificationIntervention.
 */
export async function resolveDraftClarificationIntervention(
  params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    state: AgentState;
    strategy?: SupervisorExecutionStrategy;
    touchedFiles?: readonly string[];
    usageHandler?: (usage: TaskUsageEvent) => void;
  },
  deps: InterventionDeps,
): Promise<ClarificationIntervention> {
  const cleanedDraft = deps.stripInternalDecisionMarkers(params.draft);
  if (!cleanedDraft) {
    return { kind: "none" };
  }
  if (!shouldRunClarificationReview(cleanedDraft)) {
    return { kind: "none" };
  }

  const reviewResult = await reviewClarification({
    ...params,
    draft: cleanedDraft,
  }, deps);

  return resolveDraftClarificationInterventionHelper(
    deps.clarificationContext,
    params.draft,
    reviewResult,
  );
}

/**
 * Determines whether the worker draft should become a final answer,
 * a plan-review prompt, or trigger further internal processing.
 */
export async function resolveVisibleDraftDecision(
  params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    agentState: AgentState;
    strategy: SupervisorExecutionStrategy;
    systemPrompt: string;
    selfVerification: SelfVerification;
    taskStartedAtMs: number;
    availableToolNames: readonly string[];
    terminalFailureReported?: boolean;
    usageHandler?: (usage: TaskUsageEvent) => void;
  },
  deps: InterventionDeps,
): Promise<InteractionBoundaryDecision> {
  const cleanedDraft = deps.stripInternalDecisionMarkers(params.draft).trim();
  const explicitPlanReview = userExplicitlyAskedForPlan(params.prompt);

  if (
    explicitPlanReview &&
    draftLooksLikeInternalPlanArtifact(cleanedDraft, {
      toolNames: params.availableToolNames,
    })
  ) {
    deps.interactionPolicy.requirePlanReview(
      params.chatId,
      "user explicitly asked to review a plan first",
      cleanedDraft,
    );
    return {
      kind: "plan_review",
      reason: "The user explicitly asked to review the plan before execution.",
      visibleText: deps.formatPlanReviewMessage(cleanedDraft),
    };
  }

  const rawBoundary = decideUserVisibleBoundaryHelper(deps.clarificationContext, {
    chatId: params.chatId,
    prompt: params.prompt,
    workerDraft: cleanedDraft,
    task: params.strategy.task,
    state: params.agentState,
    selfVerification: params.selfVerification,
    taskStartedAtMs: params.taskStartedAtMs,
    availableToolNames: params.availableToolNames,
    terminalFailureReported: params.terminalFailureReported,
  });
  if (rawBoundary.kind !== "final_answer") {
    return rawBoundary;
  }

  const visibleDraft = cleanedDraft
    ? await deps.synthesizeUserFacingResponse({
        chatId: params.chatId,
        identityKey: params.identityKey,
        prompt: params.prompt,
        draft: cleanedDraft,
        agentState: params.agentState,
        strategy: params.strategy,
        systemPrompt: params.systemPrompt,
        usageHandler: params.usageHandler,
      })
    : "";
  return decideUserVisibleBoundaryHelper(deps.clarificationContext, {
    chatId: params.chatId,
    prompt: params.prompt,
    workerDraft: cleanedDraft,
    visibleDraft,
    task: params.strategy.task,
    state: params.agentState,
    selfVerification: params.selfVerification,
    taskStartedAtMs: params.taskStartedAtMs,
    availableToolNames: params.availableToolNames,
    terminalFailureReported: params.terminalFailureReported,
  });
}
