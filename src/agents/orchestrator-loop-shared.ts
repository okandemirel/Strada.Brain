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
  agentState: AgentState;
  /** Interactive-only: callback to handle new instinct IDs from re-retrieval. */
  onNewInstinctIds?: (ids: string[]) => void;
}

export interface RefreshMemoryResult {
  agentState: AgentState;
  /**
   * What the refresh recalled that the run was never shown, ready to append to the history at
   * the turn about to be sent (turn-context.ts appendToLastUserTurn). Undefined when nothing new
   * came back.
   */
  recalled?: string;
}

/** Bound for what one refresh adds to the history (~3k tokens). */
const RECALLED_MAX_CHARS = 12_000;
/** Bound for the insights a run carries after repeated refreshes. */
const MAX_LEARNED_INSIGHTS = 20;
const RECALL_TRUNCATION_MARKER = "\n[… recalled context truncated …]\n";

/** The recalled memory and code context as one block, its head and tail kept when it is over the bound. */
function recalledBlock(memory: string | undefined, rag: string | undefined): string | undefined {
  const parts = [memory ? `## Relevant Memory\n${memory}` : "", rag ?? ""].filter((part) => part.trim().length > 0);
  if (parts.length === 0) return undefined;
  const block = `## Recalled during this task\n\n${parts.join("\n\n")}`;
  if (block.length <= RECALLED_MAX_CHARS) return block;
  const budget = RECALLED_MAX_CHARS - RECALL_TRUNCATION_MARKER.length;
  const head = Math.floor(budget * 0.5);
  return block.slice(0, head) + RECALL_TRUNCATION_MARKER + block.slice(block.length - (budget - head));
}

/**
 * Performs memory re-retrieval if the refresher triggers.
 *
 * Checks shouldRefresh, calls refresh(), and returns what it recalled plus the agent state with
 * any new insights. The optional `onNewInstinctIds` callback handles instinct ID deduplication
 * (Interactive-only).
 *
 * What it recalled goes into the history, once, and not into the system prompt. A refresh fires
 * every few iterations, and rewriting the system prompt each time broke the provider's prefix
 * cache for the whole history behind it (turn-context.ts). The history alone does not keep it:
 * every step trims the history to the provider's message cap and compaction summarizes old
 * turns, and the refresher never recalls the same content twice (ORC-12: it dedups against
 * everything it ever injected). So the caller hands the recall to the run's RecallLedger, which
 * puts it back on the turn about to be sent whenever a trim or compaction drops it
 * (recall-ledger.ts), and memory never stores it as conversation.
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
  let { agentState } = params;
  let recalled: string | undefined;

  if (!memoryRefresher) {
    return { agentState };
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
        // everything it ever injected).
        recalled = recalledBlock(refreshed.newMemoryContext, refreshed.newRagContext);
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

  return recalled === undefined ? { agentState } : { agentState, recalled };
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
