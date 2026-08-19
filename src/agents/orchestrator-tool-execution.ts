import type { AgentPhase } from "./agent-state.js";
import { getLoggerSafe } from "../utils/logger.js";
import type { ExecutionJournal } from "./autonomy/execution-journal.js";
import type { ToolCall, ToolResult } from "./providers/provider-core.interface.js";
import type { WorkerRunResult, WorkerToolTrace } from "./supervisor/supervisor-types.js";
import { sanitizeToolResult } from "./orchestrator-runtime-utils.js";

/** Minimal interface for TaskPlanner methods used by tracking. */
interface TaskPlannerLike {
  trackToolCall(name: string, isError: boolean): void;
  recordError(summary: string): void;
}

/** Minimal interface for SelfVerification methods used by tracking. */
interface SelfVerificationLike {
  track(toolName: string, input: unknown, result: ToolResult): void;
  ingestWorkerResult(result: WorkerRunResult): void;
}

/** Minimal interface for StradaConformanceGuard methods used by tracking. */
interface StradaConformanceLike {
  trackToolCall(name: string, input: unknown, isError: boolean, content: string): void;
}

/** Minimal interface for ErrorRecoveryEngine methods used by tracking. */
interface ErrorRecoveryLike {
  analyze(toolName: string, result: ToolResult): { summary: string; recoveryInjection: string } | null;
}

/** Optional bg-specific worker instrumentation. */
export interface WorkerCollectorLike {
  childWorkerResults: WorkerRunResult[];
  toolTrace: WorkerToolTrace[];
}

export interface ToolTrackingParams {
  chatId: string;
  toolCalls: readonly ToolCall[];
  toolResults: ToolResult[];
  taskPlanner: TaskPlannerLike;
  selfVerification: SelfVerificationLike;
  stradaConformance: StradaConformanceLike;
  errorRecovery: ErrorRecoveryLike;
  executionJournal: ExecutionJournal;
  agentPhase: AgentPhase;
  providerName: string;
  modelId?: string;
  emitToolResult: (chatId: string, tc: ToolCall, tr: ToolResult) => void;
  /** BG-specific: worker collector for delegation audit trail. */
  workerCollector?: WorkerCollectorLike;
  /** BG-specific: workspace lease id for tool trace. */
  workspaceId?: string;
}

/**
 * Tracks tool call results across autonomy engines (planner, verifier, conformance),
 * applies error recovery injection, emits per-tool events, and records the batch
 * in the execution journal.
 *
 * Shared between runBackgroundTask and runAgentLoop. The optional workerCollector
 * and workspaceId params are used only by the background path.
 *
 * @remarks Mutates `toolResults` entries in-place when error recovery injection applies.
 */
export function trackAndRecordToolResults(params: ToolTrackingParams): void {
  const {
    chatId,
    toolCalls,
    toolResults,
    taskPlanner,
    selfVerification,
    stradaConformance,
    errorRecovery,
    executionJournal,
    agentPhase,
    providerName,
    modelId,
    emitToolResult,
    workerCollector,
    workspaceId,
  } = params;

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    const tr = toolResults[i]!;
    const delegatedWorkerResult = tr.metadata?.["workerResult"] as WorkerRunResult | undefined;

    // A failing tool leaves no trace anywhere: results go into the model's
    // context and nowhere else, so after a run that called unity_scene_build
    // twice and produced no scene there was no way to learn why. The verdict is
    // the one thing worth keeping — enough of it to name the cause, not so much
    // that a log becomes a transcript.
    if (tr.isError) {
      getLoggerSafe()?.info("Tool failed", {
        tool: tc.name,
        chatId,
        detail: firstMeaningfulLine(tr.content),
      });
    }

    taskPlanner.trackToolCall(tc.name, tr.isError ?? false);
    selfVerification.track(tc.name, tc.input, tr);
    if (delegatedWorkerResult) {
      selfVerification.ingestWorkerResult(delegatedWorkerResult);
      workerCollector?.childWorkerResults.push(delegatedWorkerResult);
    }
    stradaConformance.trackToolCall(tc.name, tc.input, tr.isError ?? false, tr.content);

    if (workerCollector) {
      workerCollector.toolTrace.push({
        toolName: tc.name,
        success: !(tr.isError ?? false),
        summary: tr.content.slice(0, 200),
        timestamp: Date.now(),
        workspaceId,
      });
    }

    const analysis = errorRecovery.analyze(tc.name, tr);
    if (analysis) {
      taskPlanner.recordError(analysis.summary);
      toolResults[i] = {
        toolCallId: tr.toolCallId,
        content: sanitizeToolResult(tr.content + analysis.recoveryInjection),
        isError: tr.isError,
        metadata: tr.metadata,
      };
    }

    emitToolResult(chatId, tc, toolResults[i]!);
  }

  executionJournal.recordToolBatch({
    phase: agentPhase,
    toolCalls,
    toolResults,
    providerName,
    modelId,
  });
}

/**
 * The line of a tool result that says what went wrong.
 *
 * Tool failures often lead with a headline and then quote pages of compiler
 * output; the headline is what identifies the failure.
 */
export function firstMeaningfulLine(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "").slice(0, 300);
}
