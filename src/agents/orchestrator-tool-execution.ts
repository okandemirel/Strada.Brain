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

/** Headings under which a tool lists what actually went wrong. */
const DETAIL_HEADINGS = /^(problems?|errors?|failed|failures?):$/i;

/**
 * What a tool result says went wrong.
 *
 * The headline alone is often generic — unity_scene_build fails with "Scene NOT
 * assembled." and puts the cause under a Problems: heading below, so a log that
 * kept only the first line recorded that something failed and not why, which is
 * the whole reason for logging it. This keeps the headline and the first detail
 * beneath such a heading.
 */
export function firstMeaningfulLine(content: string): string {
  // A result that is JSON has no headline — its first line is "{" and a log of
  // that says nothing at all. Measured on batch_execute, which reports its
  // outcome as a document rather than a sentence. Pull the fields that carry the
  // reason instead.
  const fromJson = jsonFailureSummary(content);
  if (fromJson) return fromJson.slice(0, 300);

  const lines = content.split("\n").map((l) => l.trim());
  const headline = lines.find((l) => l.length > 0) ?? "";

  const headingAt = lines.findIndex((l) => DETAIL_HEADINGS.test(l));
  const detail =
    headingAt === -1
      ? undefined
      : lines.slice(headingAt + 1).find((l) => l.length > 0);

  return (detail ? `${headline} ${detail}` : headline).slice(0, 300);
}

/** Fields a JSON tool result uses to say what went wrong, in order of directness. */
const JSON_REASON_KEYS = ["error", "reason", "message", "detail", "summary"] as const;

/**
 * The failure a JSON result describes, or nothing when it is not JSON.
 *
 * Some tools answer with a document rather than a sentence, and the first line
 * of a document is a brace.
 */
function jsonFailureSummary(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  // In priority order, not in the order the document happens to list them:
  // a result carrying both "summary" and "error" should report the error.
  const atRoot = reasonKeyIn(parsed);
  if (atRoot) return atRoot;

  // A verdict document states its outcome at the top — status, plus the
  // findings it counted. Measured on unity_verify_change, whose failure was
  // logged as "message: Mono: successfully reloaded assembly": every console
  // entry in its evidence carries a message, and a depth-first reader reaches
  // the first log line long before it reaches the verdict.
  const verdict = verdictSummary(parsed);
  if (verdict) return verdict;

  // Breadth-first for the rest, so a reason at the root of the evidence
  // outranks one buried in a log the evidence happens to embed.
  let level = childrenOf(parsed);
  for (let depth = 1; depth <= 4 && level.length > 0; depth++) {
    for (const node of level) {
      const found = reasonKeyIn(node);
      if (found) return found;
    }
    level = level.flatMap(childrenOf);
  }

  return undefined;
}

function reasonKeyIn(node: unknown): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  for (const key of JSON_REASON_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return `${key}: ${value.trim()}`;
  }
  return undefined;
}

function childrenOf(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") return [];
  const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

/** "status: failed (compileIssues=27)" — the counts are the reason. */
function verdictSummary(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  const status = root["status"];
  if (typeof status !== "string" || status.trim() === "") return undefined;

  const summary = root["summary"];
  const counts: string[] = [];
  if (summary !== null && typeof summary === "object" && !Array.isArray(summary)) {
    for (const [key, value] of Object.entries(summary as Record<string, unknown>)) {
      // Zero findings and absent findings are not the reason anything failed.
      if (typeof value === "number" && value !== 0) counts.push(`${key}=${value}`);
      else if (value === false) counts.push(`${key}=false`);
    }
  }

  return counts.length > 0 ? `status: ${status.trim()} (${counts.join(", ")})` : `status: ${status.trim()}`;
}
