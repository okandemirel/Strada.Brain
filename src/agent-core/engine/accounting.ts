/**
 * Agent Core v2 — engine accounting (relocation Step 1; blueprint: project_v2_engine_relocation).
 *
 * The telemetry/usage leaf of the port's method surface, moved VERBATIM from orchestrator.ts
 * (mechanical `this.X` → `deps.X`): execution-trace recording, provider/auxiliary usage, task
 * metrics, and the failure classification the spine's verdict gate consumes. The shell keeps
 * one-line delegates until every caller relocates (Steps 2-9).
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — see engine-deps.ts.
 */

import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { TaskUsageEvent } from "../../tasks/types.js";
import type { AgentPhase } from "../../agents/agent-state.js";
import type { TaskType } from "../../metrics/metrics-types.js";
import type { SupervisorAssignment } from "../../agents/orchestrator-supervisor-routing.js";
import type { TaskClassification } from "../routing/routing-types.js";
import {
  recordProviderUsage as recordProviderUsageHelper,
  type SupervisorRoutingContext,
} from "../../agents/orchestrator-supervisor-routing.js";
import { buildExecutionTraceRecord, buildPhaseOutcomeRecord } from "../../agents/orchestrator-phase-telemetry.js";
import type {
  ExecutionPhase,
  ExecutionTraceSource,
  PhaseOutcomeStatus,
  PhaseOutcomeTelemetry,
} from "../routing/routing-types.js";
import type { ClassifyFailureParams, FailureVerdictContribution } from "../runner/orchestrator-port.js";
import type { EngineRunContext } from "./engine-deps.js";

/** The dependency slice the accounting functions read (grows only with this module). */
export interface AccountingDeps {
  /** Shell callback — the supervisor routing context is assembled from shell fields. */
  readonly getSupervisorRoutingContext: () => SupervisorRoutingContext;
  /** Shell callback — resolves the ALS-scoped task run id (explicit id wins). */
  readonly resolveTaskRunId: (chatId?: string, explicitTaskRunId?: string) => string | undefined;
  readonly providerRouter?: {
    recordExecutionTrace?: (record: ReturnType<typeof buildExecutionTraceRecord>) => void;
    recordPhaseOutcome?: (record: ReturnType<typeof buildPhaseOutcomeRecord>) => void;
  };
  readonly metricsRecorder: {
    startTask: (opts: {
      sessionId: string;
      taskDescription: string;
      taskType: TaskType;
      parentTaskId?: string;
      instinctIds?: string[];
    }) => string;
    endTask: (metricId: string, result: RecordMetricEndResult) => void;
  } | null;
  readonly metrics?: {
    recordTokenUsage: (inputTokens: number, outputTokens: number, provider: string) => void;
  };
  readonly rateLimiter?: {
    recordTokenUsage: (inputTokens: number, outputTokens: number, provider: string) => void;
  };
}

export interface RecordExecutionTraceParams {
  chatId?: string;
  identityKey: string;
  assignment: SupervisorAssignment;
  phase: ExecutionPhase;
  source?: ExecutionTraceSource;
  task: TaskClassification;
  reason?: string;
  taskRunId?: string;
}

export interface RecordPhaseOutcomeParams {
  chatId?: string;
  identityKey: string;
  assignment: SupervisorAssignment;
  phase: ExecutionPhase;
  status: PhaseOutcomeStatus;
  task: TaskClassification;
  source?: ExecutionTraceSource;
  reason?: string;
  telemetry?: PhaseOutcomeTelemetry;
  taskRunId?: string;
}

export interface RecordMetricEndResult {
  agentPhase: AgentPhase;
  iterations: number;
  toolCallCount: number;
  hitMaxIterations?: boolean;
  iterationBudgetReached?: boolean;
  continuedAfterBudget?: boolean;
  epochCount?: number;
  terminatedByIterationBudget?: boolean;
}

export function recordProviderUsage(
  deps: AccountingDeps,
  providerName: string,
  usage: ProviderResponse["usage"] | undefined,
  onUsage?: (usage: TaskUsageEvent) => void,
  modelId?: string,
): void {
  recordProviderUsageHelper(deps.getSupervisorRoutingContext(), providerName, usage, onUsage, modelId);
}

export function recordExecutionTrace(deps: AccountingDeps, params: RecordExecutionTraceParams): void {
  deps.providerRouter?.recordExecutionTrace?.(
    buildExecutionTraceRecord({
      identityKey: params.identityKey,
      assignment: params.assignment,
      phase: params.phase,
      source: params.source,
      task: params.task,
      reason: params.reason,
      timestampMs: Date.now(),
      chatId: params.chatId,
      taskRunId: deps.resolveTaskRunId(params.chatId, params.taskRunId),
    }),
  );
}

export function recordPhaseOutcome(deps: AccountingDeps, params: RecordPhaseOutcomeParams): void {
  deps.providerRouter?.recordPhaseOutcome?.(
    buildPhaseOutcomeRecord({
      identityKey: params.identityKey,
      assignment: params.assignment,
      phase: params.phase,
      status: params.status,
      task: params.task,
      timestampMs: Date.now(),
      source: params.source,
      reason: params.reason,
      telemetry: params.telemetry,
      chatId: params.chatId,
      taskRunId: deps.resolveTaskRunId(params.chatId, params.taskRunId),
    }),
  );
}

export function recordMetricEnd(
  deps: AccountingDeps,
  metricId: string | undefined,
  result: RecordMetricEndResult,
): void {
  if (metricId) {
    deps.metricsRecorder?.endTask(metricId, result);
  }
}

export function recordAuxiliaryUsage(
  deps: AccountingDeps,
  provider: string,
  usage: ProviderResponse["usage"] | undefined,
  sink?: (usage: TaskUsageEvent) => void,
): void {
  if (!usage) {
    return;
  }

  deps.metrics?.recordTokenUsage(usage.inputTokens, usage.outputTokens, provider);
  deps.rateLimiter?.recordTokenUsage(usage.inputTokens, usage.outputTokens, provider);
  sink?.({
    provider,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
}

/**
 * The spine's failure-verdict contribution (moved VERBATIM): records the tracker half on the
 * run's health adapter and classifies the failed call for the FailureLedger.
 */
export function classifyAgentCoreFailure(
  params: ClassifyFailureParams,
  runCtx: EngineRunContext,
): FailureVerdictContribution {
  runCtx.healthAdapter.setProvider(params.provider);
  runCtx.healthAdapter.recordFailure(); // tracker-half; false=non-benign is the only path here
  const reason = params.failedCallReason;
  const callStalled = reason?.kind === "provider-stall" || reason?.kind === "hard-timeout";
  // A task-scoped abort surfaces here only for the two scoped kinds; else null (the spine
  // overrides taskCancelReason with runClock.taskToken.reason anyway).
  const taskCancelReason =
    reason && (reason.kind === "provider-stall" || reason.kind === "hard-timeout") && reason.scope === "task"
      ? reason
      : null;
  return { callStalled, taskCancelReason, benign: false };
}
