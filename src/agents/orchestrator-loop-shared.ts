/**
 * orchestrator-loop-shared.ts
 *
 * Shared patterns extracted from both runBackgroundTask and runAgentLoop
 * to eliminate duplication. Each function encapsulates an identical inline
 * pattern that appeared in both loops.
 */

import type { MessageContent, ToolCall, ToolResult } from "./providers/provider-core.interface.js";
import type { ConversationMessage } from "./providers/provider.interface.js";
import type { AgentState } from "./agent-state.js";
import type { ToolTrackingParams } from "./orchestrator-tool-execution.js";
import { trackAndRecordToolResults } from "./orchestrator-tool-execution.js";
import type { ConsensusVerificationParams } from "./orchestrator-consensus.js";
import { runConsensusVerification } from "./orchestrator-consensus.js";
import { replaceSection } from "./orchestrator-runtime-utils.js";
import type {
  ExecutionPhase,
  PhaseOutcomeStatus,
  PhaseOutcomeTelemetry,
  TaskClassification,
  VerifierDecision,
} from "../agent-core/routing/routing-types.js";
import type { SupervisorAssignment, SupervisorExecutionStrategy } from "./orchestrator-supervisor-routing.js";
import type { ConfidenceEstimator } from "../agent-core/routing/confidence-estimator.js";
import type { MemoryRefresher } from "./memory-refresher.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { getLoggerSafe } from "../utils/logger.js";

/**
 * The first clause of a prompt — the ≤2s intent-ack fallback shared by the v1 port's
 * `classifyIntent` stub and the v2 spine's `intentAck` race. Trims to the first sentence
 * boundary, clamps to 120 chars, and falls back to a generic ack.
 */
export function firstClause(prompt: string): string {
  const trimmed = prompt.trim();
  const cut = trimmed.search(/[.!?\n]/);
  const clause = (cut === -1 ? trimmed : trimmed.slice(0, cut)).trim();
  return clause.length > 0 ? clause.slice(0, 120) : "Working on your request.";
}

// =============================================================================
// Pattern 1: executeAndTrackTools
// =============================================================================

/**
 * Options shared between BG and Interactive tool execution + tracking.
 * The `executeToolCalls` callback delegates to the Orchestrator's private method.
 */
export interface ExecuteAndTrackToolsParams {
  chatId: string;
  responseText: string;
  toolCalls: ToolCall[];
  session: { messages: ConversationMessage[] };
  executeToolCalls: (chatId: string, toolCalls: ToolCall[], opts: Record<string, unknown>) => Promise<ToolResult[]>;
  executeOptions: Record<string, unknown>;
  trackingParams: Omit<ToolTrackingParams, "chatId" | "toolCalls" | "toolResults">;
}

export interface ExecuteAndTrackToolsResult {
  toolResults: ToolResult[];
}

/**
 * Pushes the assistant message with tool_calls, executes tool calls via
 * the provided callback, and runs autonomy tracking.
 *
 * Shared between runBackgroundTask and runAgentLoop. The caller is
 * responsible for any loop-specific post-processing (e.g. controlLoopTracker
 * in the background path, stateCtx in the interactive path).
 */
export async function executeAndTrackTools(
  params: ExecuteAndTrackToolsParams,
): Promise<ExecuteAndTrackToolsResult> {
  const {
    chatId,
    responseText,
    toolCalls,
    session,
    executeToolCalls,
    executeOptions,
    trackingParams,
  } = params;

  // Push the assistant message with tool_calls into the session
  session.messages.push({
    role: "assistant",
    content: responseText,
    tool_calls: toolCalls,
  });

  let toolResults: ToolResult[] | undefined;
  try {
    // Execute all tool calls
    toolResults = await executeToolCalls(chatId, toolCalls, executeOptions);

    // Autonomy tracking
    trackAndRecordToolResults({
      chatId,
      toolCalls,
      toolResults,
      ...trackingParams,
    });
  } catch (error) {
    // The tool_use turn is already in the session, and sessions persist: left
    // without its tool_result, every later request on the chat is rejected.
    // Answer every call id — with the real result where one exists — then let
    // the caller see the failure.
    session.messages.push({ role: "user", content: toolResultsOrFailure(toolCalls, toolResults, error) });
    throw error;
  }

  return { toolResults };
}

/** One tool_result block per call: its real result when there is one, else the failure. */
function toolResultsOrFailure(
  toolCalls: readonly ToolCall[],
  toolResults: readonly ToolResult[] | undefined,
  error: unknown,
): MessageContent[] {
  const reason = error instanceof Error ? error.message : String(error);
  return toolCalls.map((tc): MessageContent => {
    const result = toolResults?.find((r) => r.toolCallId === tc.id);
    return result
      ? { type: "tool_result", tool_use_id: tc.id, content: result.content, is_error: result.isError }
      : { type: "tool_result", tool_use_id: tc.id, content: `Tool execution failed: ${reason}`, is_error: true };
  });
}

// =============================================================================
// Pattern 2: refreshMemoryIfNeeded
// =============================================================================

export interface RefreshMemoryParams {
  memoryRefresher: MemoryRefresher | null;
  iteration: number;
  /** For Interactive: extracted from session. For BG: the task prompt. */
  queryContext: string;
  chatId: string;
  systemPrompt: string;
  agentState: AgentState;
  /** Interactive-only: callback to handle new instinct IDs from re-retrieval. */
  onNewInstinctIds?: (ids: string[]) => void;
}

export interface RefreshMemoryResult {
  systemPrompt: string;
  agentState: AgentState;
}

/** Bound for a re-retrieval section that accumulates across refreshes (~3k tokens). */
const REFRESHED_SECTION_MAX_CHARS = 12_000;
/** Bound for the insights a run carries after repeated refreshes. */
const MAX_LEARNED_INSIGHTS = 20;
const SECTION_TRUNCATION_MARKER = "\n[… older retrieved context truncated …]\n";

/** The body between a section's markers, or undefined when the prompt has no such section. */
function readSection(prompt: string, tag: string): string | undefined {
  const startMarker = `<!-- ${tag}:start -->`;
  const endMarker = `<!-- ${tag}:end -->`;
  const startIdx = prompt.indexOf(startMarker);
  const endIdx = prompt.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return undefined;
  return prompt.slice(startIdx + startMarker.length, endIdx).replace(/^\n/, "").replace(/\n$/, "");
}

/**
 * Add newly retrieved content to a section, keeping what it already holds. Over the bound, the
 * head (the initial retrieval, the most relevant to the task) and the newest additions are kept.
 */
function appendToSection(prompt: string, tag: string, addition: string, header = ""): string {
  const existing = readSection(prompt, tag)?.trim();
  const combined = existing ? `${existing}\n---\n${addition}` : `${header}${addition}`;
  if (combined.length <= REFRESHED_SECTION_MAX_CHARS) return replaceSection(prompt, tag, combined);
  const budget = REFRESHED_SECTION_MAX_CHARS - SECTION_TRUNCATION_MARKER.length;
  const head = Math.floor(budget * 0.5);
  const capped = combined.slice(0, head) + SECTION_TRUNCATION_MARKER + combined.slice(combined.length - (budget - head));
  return replaceSection(prompt, tag, capped);
}

/**
 * Performs memory re-retrieval if the refresher triggers.
 *
 * Checks shouldRefresh, calls refresh(), then updates system prompt
 * sections and agent state insights. The optional `onNewInstinctIds`
 * callback handles instinct ID deduplication (Interactive-only).
 *
 * Non-fatal: any error is caught and swallowed.
 */
export async function refreshMemoryIfNeeded(
  params: RefreshMemoryParams,
): Promise<RefreshMemoryResult> {
  const {
    memoryRefresher,
    iteration,
    queryContext,
    chatId,
    onNewInstinctIds,
  } = params;
  let { systemPrompt, agentState } = params;

  if (!memoryRefresher) {
    return { systemPrompt, agentState };
  }

  try {
    const check = await memoryRefresher.shouldRefresh(iteration, queryContext, chatId);
    if (check.should) {
      const refreshed = await memoryRefresher.refresh(
        queryContext,
        chatId,
        check.reason,
        iteration,
        check.cosineDistance,
      );
      if (refreshed.triggered) {
        // A refresh returns only what was NOT shown before (the refresher dedups against
        // everything it ever injected), so the sections accumulate: replacing them with the
        // new items dropped the initial RAG block and every earlier recall for the rest of
        // the run, and they could never come back (their hashes stay "injected").
        if (refreshed.newMemoryContext) {
          systemPrompt = appendToSection(
            systemPrompt,
            "re-retrieval:memory",
            refreshed.newMemoryContext,
            "## Relevant Memory\n",
          );
        }
        if (refreshed.newRagContext) {
          systemPrompt = appendToSection(systemPrompt, "re-retrieval:rag", refreshed.newRagContext);
        }
        if (refreshed.newInsights?.length) {
          const merged = [...new Set([...(agentState.learnedInsights ?? []), ...refreshed.newInsights])];
          agentState = { ...agentState, learnedInsights: merged.slice(-MAX_LEARNED_INSIGHTS) };
        }
        if (refreshed.newInstinctIds?.length && onNewInstinctIds) {
          onNewInstinctIds(refreshed.newInstinctIds);
        }
      }
    }
  } catch (err) {
    getLoggerSafe().warn("Memory re-retrieval failed", { error: err instanceof Error ? err.message : String(err) });
  }

  return { systemPrompt, agentState };
}

// =============================================================================
// Pattern 3: runConsensusIfAvailable
// =============================================================================

/** Inputs for building consensus verification params from loop context. */
export interface ConsensusContext {
  consensusManager: ConsensusVerificationParams["consensusManager"];
  confidenceEstimator: ConfidenceEstimator;
  providerManager: { listAvailable(): unknown[] };
  taskClassifier: { classify(prompt: string): TaskClassification };
  prompt: string;
  responseText: string;
  toolCalls: readonly ToolCall[];
  currentAssignment: SupervisorAssignment;
  currentProviderCapabilities: Parameters<ConfidenceEstimator["estimate"]>[0]["providerCapabilities"];
  agentState: AgentState;
  executionStrategy: SupervisorExecutionStrategy;
  identityKey: string;
  chatId: string;
  logLabel?: string;
  /** Where the reviewer's spend is booked (audit 03.3 / D22). */
  onUsage?: ConsensusVerificationParams["onUsage"];
  resolveConsensusReviewAssignment: (
    reviewer: SupervisorAssignment,
    current: SupervisorAssignment,
    identityKey: string,
  ) => SupervisorAssignment | null | undefined;
  recordExecutionTrace: ConsensusVerificationParams["recordExecutionTrace"];
  recordPhaseOutcome: ConsensusVerificationParams["recordPhaseOutcome"];
}

/**
 * Classifies the task, estimates confidence, and runs consensus verification
 * if the necessary services are available.
 *
 * This encapsulates the identical 20-line param-assembly + call pattern
 * that appears in both the BG and Interactive tool-execution paths.
 *
 * Non-fatal: any error is caught and swallowed.
 */
export async function runConsensusIfAvailable(
  ctx: ConsensusContext,
): Promise<import("./orchestrator-consensus.js").ConsensusVerdict | undefined> {
  if (!ctx.consensusManager || !ctx.confidenceEstimator) return undefined;

  try {
    const taskClass = ctx.taskClassifier.classify(ctx.prompt);
    if (
      ctx.toolCalls.length > 0 &&
      taskClass.criticality !== "critical" &&
      taskClass.type !== "destructive-operation"
    ) {
      return undefined;
    }
    const confidence = ctx.confidenceEstimator.estimate({
      task: taskClass,
      providerName: ctx.currentAssignment.providerName,
      providerCapabilities: ctx.currentProviderCapabilities,
      agentState: ctx.agentState,
      responseLength: ctx.responseText.length,
    });
    return await runConsensusVerification({
      consensusManager: ctx.consensusManager,
      availableProviderCount: ctx.providerManager.listAvailable().length,
      taskClass,
      confidence,
      originalOutput: {
        text: ctx.responseText,
        toolCalls: ctx.toolCalls.map((tc) => ({ name: tc.name, input: tc.input })),
      },
      originalProviderName: ctx.currentAssignment.providerName,
      prompt: ctx.prompt,
      reviewAssignment: ctx.resolveConsensusReviewAssignment(
        ctx.executionStrategy.reviewer,
        ctx.currentAssignment,
        ctx.identityKey,
      ),
      chatId: ctx.chatId,
      onUsage: ctx.onUsage,
      identityKey: ctx.identityKey,
      logLabel: ctx.logLabel,
      recordExecutionTrace: ctx.recordExecutionTrace,
      recordPhaseOutcome: ctx.recordPhaseOutcome,
    });
  } catch (err) {
    getLoggerSafe().warn("Consensus verification failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return undefined;
}

// =============================================================================
// Shared types for handler context callbacks
// (used by orchestrator-reflection-handler.ts and orchestrator-end-turn-handler.ts)
// =============================================================================

export interface RecordPhaseOutcomeParams {
  chatId: string;
  identityKey: string;
  assignment: SupervisorAssignment;
  phase: ExecutionPhase;
  status: PhaseOutcomeStatus;
  task: TaskClassification;
  reason?: string;
  telemetry?: PhaseOutcomeTelemetry;
}

export interface BuildPhaseOutcomeTelemetryParams {
  state?: AgentState;
  usage?: ProviderResponse["usage"];
  verifierDecision?: VerifierDecision;
  failureReason?: string | null;
}

// =============================================================================
// Pattern 4: pushContinuationMessages
// =============================================================================

/** Gate injected when a provider returns `max_tokens` and the loop auto-continues. */
export const MAX_TOKENS_CONTINUATION_GATE =
  "Your previous response was cut off due to output length limits. Continue exactly where you left off.";

/**
 * Appends the current assistant response (if any) and a user continuation gate
 * into the session message list.
 *
 * Shared between orchestrator-reflection-handler and orchestrator-end-turn-handler.
 */
export function pushContinuationMessages(
  ctx: { responseText: string | undefined; session: { messages: Array<{ role: string; content: string | unknown[] }> } },
  gate: string,
): void {
  if (ctx.responseText) {
    ctx.session.messages.push({ role: "assistant", content: ctx.responseText });
  }
  ctx.session.messages.push({ role: "user", content: gate });
}
