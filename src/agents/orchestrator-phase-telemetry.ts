import {
  AgentPhase,
  transitionPhase,
  type AgentState,
} from "./agent-state.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import type { ProviderServedBy } from "./providers/provider-core.interface.js";
import type {
  ExecutionTrace,
  ExecutionPhase,
  ExecutionTraceSource,
  PhaseOutcome,
  PhaseOutcomeStatus,
  PhaseOutcomeTelemetry,
  TaskClassification,
  VerifierDecision,
} from "../agent-core/routing/routing-types.js";
import { derivePhaseVerdict } from "../agent-core/routing/phase-verdict.js";
import {
  extractApproachSummary,
  normalizeFailureFingerprint,
} from "./orchestrator-runtime-utils.js";

type SupervisorTraceRole = ExecutionTrace["role"];

interface TelemetryAssignment {
  providerName: string;
  modelId?: string;
  role: SupervisorTraceRole;
  reason: string;
  traceSource?: ExecutionTraceSource;
  servedBy?: ProviderServedBy;
}

/**
 * audited 2026-09-02: attribute a turn to the provider that actually answered.
 * The assignment names the router's pick; a fallback chain may have skipped a
 * cooled pick and answered from a sibling. When the chain reports who served,
 * that identity wins. The model follows the same rule: a sibling with an
 * unknown model is recorded with no model, never paired with the assigned one.
 */
export function resolveServedIdentity(
  assignment: { providerName: string; modelId?: string },
  servedBy: ProviderServedBy | undefined,
): { provider: string; model?: string } {
  if (!servedBy) return { provider: assignment.providerName, model: assignment.modelId };
  const model = servedBy.model
    ?? (servedBy.provider === assignment.providerName ? assignment.modelId : undefined);
  return { provider: servedBy.provider, model };
}

export function toExecutionPhase(phase: AgentPhase): ExecutionPhase {
  switch (phase) {
    case AgentPhase.PLANNING:
      return "planning";
    case AgentPhase.REFLECTING:
      return "reflecting";
    case AgentPhase.REPLANNING:
      return "replanning";
    case AgentPhase.EXECUTING:
    case AgentPhase.COMPLETE:
    case AgentPhase.FAILED:
    default:
      return "executing";
  }
}

export function toPhaseOutcomeStatus(
  decision: "approve" | "continue" | "replan",
): PhaseOutcomeStatus {
  switch (decision) {
    case "approve":
      return "approved";
    case "replan":
      return "replanned";
    case "continue":
    default:
      return "continued";
  }
}

export function transitionToVerifierReplan(
  state: AgentState,
  reflectionText?: string | null,
): AgentState {
  const enrichedState: AgentState = {
    ...state,
    failedApproaches: [...state.failedApproaches, extractApproachSummary(state)],
    lastReflection: reflectionText ?? state.lastReflection,
    reflectionCount: state.reflectionCount + 1,
    consecutiveErrors: 0,
  };

  if (enrichedState.phase === AgentPhase.REFLECTING) {
    return transitionPhase(enrichedState, AgentPhase.REPLANNING);
  }

  if (enrichedState.phase === AgentPhase.EXECUTING) {
    return transitionPhase(
      transitionPhase(enrichedState, AgentPhase.REFLECTING),
      AgentPhase.REPLANNING,
    );
  }

  return transitionPhase(enrichedState, AgentPhase.REPLANNING);
}

export function resolveExecutionTraceSource(
  assignment: Pick<TelemetryAssignment, "traceSource">,
  fallback: ExecutionTraceSource = "supervisor-strategy",
): ExecutionTraceSource {
  return assignment.traceSource ?? fallback;
}

export function buildExecutionTraceRecord(params: {
  identityKey: string;
  assignment: TelemetryAssignment;
  phase: ExecutionPhase;
  task: TaskClassification;
  source?: ExecutionTraceSource;
  reason?: string;
  timestampMs: number;
  chatId?: string;
  taskRunId?: string;
}): ExecutionTrace {
  // audited 2026-09-02: attributed to who served, not to the router's pick.
  const served = resolveServedIdentity(params.assignment, params.assignment.servedBy);
  return {
    provider: served.provider,
    model: served.model,
    role: params.assignment.role,
    phase: params.phase,
    source: params.source ?? resolveExecutionTraceSource(params.assignment),
    reason: params.reason ?? params.assignment.reason,
    task: params.task,
    timestamp: params.timestampMs,
    identityKey: params.identityKey,
    chatId: params.chatId,
    taskRunId: params.taskRunId,
  };
}

export function buildPhaseOutcomeRecord(params: {
  identityKey: string;
  assignment: TelemetryAssignment;
  phase: ExecutionPhase;
  status: PhaseOutcomeStatus;
  task: TaskClassification;
  timestampMs: number;
  source?: ExecutionTraceSource;
  reason?: string;
  telemetry?: PhaseOutcomeTelemetry;
  chatId?: string;
  taskRunId?: string;
}): PhaseOutcome {
  // audited 2026-09-02: an approved planning turn served by opencode2 was raising
  // openai's deepPlanning profile because only the assigned name was stamped.
  const served = resolveServedIdentity(params.assignment, params.assignment.servedBy);
  return {
    provider: served.provider,
    model: served.model,
    role: params.assignment.role,
    phase: params.phase,
    source: params.source ?? resolveExecutionTraceSource(params.assignment),
    status: params.status,
    reason: params.reason ?? params.assignment.reason,
    task: params.task,
    timestamp: params.timestampMs,
    identityKey: params.identityKey,
    chatId: params.chatId,
    taskRunId: params.taskRunId,
    telemetry: buildPhaseOutcomeVerdictTelemetry(params.status, params.telemetry),
  };
}

export function buildPhaseOutcomeTelemetry(params: {
  state?: AgentState;
  usage?: ProviderResponse["usage"];
  verifierDecision?: VerifierDecision;
  failureReason?: string | null;
  projectWorldFingerprint?: string;
}): PhaseOutcomeTelemetry | undefined {
  const inputTokens = params.usage?.inputTokens ?? 0;
  const outputTokens = params.usage?.outputTokens ?? 0;
  const retryCount = Math.max(0, params.state?.reflectionCount ?? 0);
  const rollbackDepth = Math.max(0, params.state?.failedApproaches.length ?? 0);
  const failureFingerprint = normalizeFailureFingerprint(
    params.failureReason
      ?? (params.state ? extractApproachSummary(params.state) : ""),
  );

  if (
    !params.verifierDecision &&
    inputTokens === 0 &&
    outputTokens === 0 &&
    retryCount === 0 &&
    rollbackDepth === 0 &&
    !failureFingerprint
  ) {
    return undefined;
  }

  return {
    verifierDecision: params.verifierDecision,
    retryCount,
    rollbackDepth,
    failureFingerprint: failureFingerprint || undefined,
    projectWorldFingerprint: params.projectWorldFingerprint || undefined,
    inputTokens,
    outputTokens,
  };
}

export function buildPhaseOutcomeVerdictTelemetry(
  status: PhaseOutcomeStatus,
  telemetry?: PhaseOutcomeTelemetry,
): PhaseOutcomeTelemetry | undefined {
  const verdict = derivePhaseVerdict(status, telemetry?.verifierDecision);
  if (!telemetry && !verdict) {
    return undefined;
  }
  return {
    ...telemetry,
    phaseVerdict: verdict?.label ?? telemetry?.phaseVerdict,
    phaseVerdictScore: verdict?.score ?? telemetry?.phaseVerdictScore,
  };
}
