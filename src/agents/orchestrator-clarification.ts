import type { TaskClassification } from "../agent-core/routing/routing-types.js";
import type { AgentState } from "./agent-state.js";
import type { InteractionConfig } from "../config/config.js";
import {
  collectCompletionReviewEvidence,
  decideInteractionBoundary,
  shouldRunClarificationReview,
  collectClarificationReviewEvidence,
  buildClarificationContinuationGate,
  formatClarificationPrompt,
  type ClarificationBlockingType,
  type ClarificationReviewDecision,
  type InteractionBoundaryDecision,
  type SelfVerification,
} from "./autonomy/index.js";
import { getLogRingBuffer } from "../utils/logger.js";
import {
  extractExactResponseLiteral,
  applyVisibleResponseContract,
} from "./orchestrator-text-utils.js";
import { stripInternalDecisionMarkers } from "./orchestrator-supervisor-routing.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const LOCAL_INSPECTION_SCOPE_RE =
  /(?:[A-Za-z0-9_./\\-]+\.(?:cs|ts|tsx|js|jsx|json|ya?ml|md|asset|prefab|unity|scene)|\b(?:file|repo|repository|project|module|component|system|class|function|provider|orchestrator|memory|routing|build|compile|error|warning|bug|crash|freeze|runtime|editor|unity|stack trace|log|test|implement|create|write|add|fix|debug|refactor|review|analy[sz]e)\b)/iu;

const INTERNAL_TECHNICAL_CHOICE_RE =
  /\b(?:package|dependency|library|provider|refactor|architecture|implementation|approach|path|module|service|screen|tool|install|upgrade|downgrade|split|merge|integration)\b/iu;

const HARD_BLOCKER_TEXT_RE =
  /\b(?:credential|token|api[_ -]?key|login|account|subscription|permission|access|billing|quota|approval|approve|destructive|irreversible|delete|drop|wipe|deploy|upload|attach|artifact|external)\b/iu;

const HARD_BLOCKER_CLARIFICATION_TYPES = new Set<ClarificationBlockingType>([
  "missing_external_info",
  "credential_or_access",
  "risky_irreversible_action",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClarificationIntervention {
  kind: "none" | "continue" | "ask_user" | "blocked";
  gate?: string;
  message?: string;
  input?: Record<string, unknown>;
}

/**
 * Readonly context interface carrying the Orchestrator fields
 * needed by clarification standalone functions.
 */
export interface ClarificationContext {
  readonly interactionConfig: InteractionConfig;
  readonly toolMetadataByName: ReadonlyMap<string, { readonly readOnly?: boolean }>;
}

// ─── Functions ────────────────────────────────────────────────────────────────

export function hasLocalInspectionScope(prompt: string, task: TaskClassification): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  if (extractExactResponseLiteral(trimmed)) {
    return false;
  }
  if (task.type === "simple-question") {
    return false;
  }
  if (LOCAL_INSPECTION_SCOPE_RE.test(trimmed)) {
    return true;
  }
  return false;
}

export function canInspectLocally(
  ctx: ClarificationContext,
  prompt: string,
  task: TaskClassification,
  availableToolNames: readonly string[],
): boolean {
  const hasReadableTool = availableToolNames.some(
    (name) => ctx.toolMetadataByName.get(name)?.readOnly !== false,
  );
  return hasReadableTool && hasLocalInspectionScope(prompt, task);
}

export function collectInteractionBoundaryEvidence(
  chatId: string,
  state: AgentState,
  selfVerification: SelfVerification,
  taskStartedAtMs: number,
) {
  const logEntries = typeof getLogRingBuffer === "function" ? getLogRingBuffer() : [];
  return collectCompletionReviewEvidence({
    state,
    verificationState: selfVerification.getState(),
    logEntries,
    chatId,
    taskStartedAtMs,
  });
}

export function decideUserVisibleBoundary(
  ctx: ClarificationContext,
  params: {
    chatId: string;
    prompt: string;
    workerDraft: string;
    visibleDraft?: string;
    task: TaskClassification;
    state: AgentState;
    selfVerification: SelfVerification;
    taskStartedAtMs: number;
    availableToolNames: readonly string[];
    terminalFailureReported?: boolean;
  },
): InteractionBoundaryDecision {
  return decideInteractionBoundary({
    prompt: params.prompt,
    workerDraft: params.workerDraft,
    visibleDraft: params.visibleDraft ?? "",
    task: params.task,
    evidence: collectInteractionBoundaryEvidence(
      params.chatId,
      params.state,
      params.selfVerification,
      params.taskStartedAtMs,
    ),
    canInspectLocally: canInspectLocally(
      ctx,
      params.prompt,
      params.task,
      params.availableToolNames,
    ),
    terminalFailureReported: params.terminalFailureReported,
    availableToolNames: params.availableToolNames,
  });
}

export function buildSafeVisibleFallbackFromDraft(
  prompt: string,
  draft: string,
  task: TaskClassification,
  allowDirectFinalAnswer = true,
): string {
  const cleanedDraft = stripInternalDecisionMarkers(draft).trim();
  if (!cleanedDraft) {
    return "";
  }

  const fallbackDecision = decideInteractionBoundary({
    prompt,
    workerDraft: cleanedDraft,
    visibleDraft: "",
    task,
    canInspectLocally: false,
    availableToolNames: [],
    evidence: {
      touchedFiles: [],
      recentFailures: [],
      recentLogIssues: [],
      recentSteps: [],
      totalStepCount: 0,
      inspectionStepCount: 0,
      verificationStepCount: 0,
      mutationStepCount: 0,
      verificationState: {
        pendingFiles: new Set(),
        touchedFiles: new Set(),
        hasCompilableChanges: false,
        lastBuildOk: null,
        lastVerificationAt: null,
        unityConsoleErrors: [],
        unityErrorResolutionAttempts: 0,
      },
    },
  });

  if (fallbackDecision.kind === "terminal_failure" && fallbackDecision.visibleText) {
    return applyVisibleResponseContract(prompt, fallbackDecision.visibleText);
  }

  if (
    allowDirectFinalAnswer &&
    fallbackDecision.kind === "final_answer" &&
    fallbackDecision.visibleText
  ) {
    return applyVisibleResponseContract(prompt, fallbackDecision.visibleText);
  }

  return applyVisibleResponseContract(
    prompt,
    "Task execution completed, but Strada could not safely synthesize a user-facing summary from the internal worker output. Review the task trace or rerun the task for a clean final summary.",
  );
}

export function looksLikeInternalTechnicalChoice(text: string): boolean {
  return INTERNAL_TECHNICAL_CHOICE_RE.test(text);
}

export function shouldKeepClarificationInternal(
  ctx: ClarificationContext,
  decision: ClarificationReviewDecision | null | undefined,
  text: string,
  progressStuck?: boolean,
): boolean {
  if (progressStuck) return false;
  if (!decision || (decision.decision !== "ask_user" && decision.decision !== "blocked")) {
    return false;
  }
  if (ctx.interactionConfig.escalationPolicy !== "hard-blockers-only") {
    return false;
  }
  if (looksLikeInternalTechnicalChoice(text)) {
    return true;
  }
  if (decision.blockingType) {
    return !HARD_BLOCKER_CLARIFICATION_TYPES.has(decision.blockingType);
  }
  return !HARD_BLOCKER_TEXT_RE.test(text);
}

export function toInternalClarificationDecision(
  decision: ClarificationReviewDecision | null | undefined,
): ClarificationReviewDecision {
  return {
    decision: "internal_continue",
    reason:
      decision?.reason?.trim() ||
      "Silent-first autonomy keeps local engineering decisions inside Strada until a real hard blocker exists.",
    recommendedNextAction:
      decision?.recommendedNextAction?.trim() ||
      "Resolve the local technical decision internally and continue execution without user escalation.",
  };
}

export function resolveDraftClarificationIntervention(
  ctx: ClarificationContext,
  draft: string,
  reviewResult: {
    decision: ClarificationReviewDecision | null | undefined;
    evidence: ReturnType<typeof collectClarificationReviewEvidence>;
  },
): ClarificationIntervention {
  const cleanedDraft = stripInternalDecisionMarkers(draft);
  if (!cleanedDraft) {
    return { kind: "none" };
  }
  if (!shouldRunClarificationReview(cleanedDraft)) {
    return { kind: "none" };
  }

  const { decision, evidence } = reviewResult;

  if (
    decision?.decision === "internal_continue" ||
    shouldKeepClarificationInternal(ctx, decision, cleanedDraft)
  ) {
    return {
      kind: "continue",
      gate: buildClarificationContinuationGate(
        evidence,
        toInternalClarificationDecision(decision),
      ),
    };
  }

  switch (decision?.decision) {
    case "ask_user":
    case "blocked":
      return {
        kind: decision.decision,
        message: formatClarificationPrompt(decision) ?? undefined,
      };
    default:
      return { kind: "none" };
  }
}

export function resolveAskUserClarificationIntervention(
  ctx: ClarificationContext,
  toolCallInput: Record<string, unknown>,
  reviewResult: {
    decision: ClarificationReviewDecision | null | undefined;
    evidence: ReturnType<typeof collectClarificationReviewEvidence>;
  },
  normalizeText: (value: unknown) => string,
): ClarificationIntervention {
  const question = normalizeText(toolCallInput["question"]);
  const context = normalizeText(toolCallInput["context"]);
  const options = Array.isArray(toolCallInput["options"])
    ? toolCallInput["options"]
        .map((option) => normalizeText(option))
        .filter(Boolean)
    : [];
  const recommended = normalizeText(toolCallInput["recommended"]);
  const draft = [
    context ? `Context: ${context}` : "",
    question ? `Question: ${question}` : "",
    options.length > 0 ? `Options: ${options.join(" | ")}` : "",
    recommended ? `Recommended: ${recommended}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { decision, evidence } = reviewResult;

  if (
    decision?.decision === "internal_continue" ||
    shouldKeepClarificationInternal(ctx, decision, draft)
  ) {
    return {
      kind: "continue",
      gate: buildClarificationContinuationGate(
        evidence,
        toInternalClarificationDecision(decision),
      ),
    };
  }

  if (decision?.decision === "ask_user" || decision?.decision === "blocked") {
    const approvedQuestion = decision.question?.trim() || question;
    const approvedOptions =
      decision.options?.filter((option) => option.trim().length > 0) ?? options;
    const approvedRecommended = decision.recommendedOption?.trim() || recommended || undefined;

    return {
      kind: decision.decision,
      input: {
        question: approvedQuestion,
        ...(approvedOptions.length > 0 ? { options: approvedOptions } : {}),
        ...(approvedRecommended ? { recommended: approvedRecommended } : {}),
        ...(decision.reason?.trim()
          ? { context: decision.reason.trim() }
          : context
            ? { context }
            : {}),
      },
    };
  }

  return { kind: "none" };
}
