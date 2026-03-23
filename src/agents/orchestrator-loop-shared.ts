/**
 * orchestrator-loop-shared.ts
 *
 * Shared patterns extracted from both runBackgroundTask and runAgentLoop
 * to eliminate duplication. Each function encapsulates an identical inline
 * pattern that appeared in both loops.
 */

import type { ToolCall, ToolResult } from "./providers/provider-core.interface.js";
import type { ConversationMessage } from "./providers/provider.interface.js";
import type { AgentState } from "./agent-state.js";
import type { ToolTrackingParams } from "./orchestrator-tool-execution.js";
import { trackAndRecordToolResults } from "./orchestrator-tool-execution.js";
import type { ConsensusVerificationParams } from "./orchestrator-consensus.js";
import { runConsensusVerification } from "./orchestrator-consensus.js";
import { replaceSection } from "./orchestrator-runtime-utils.js";
import type { TaskClassification } from "../agent-core/routing/routing-types.js";
import type { SupervisorAssignment, SupervisorExecutionStrategy } from "./orchestrator-supervisor-routing.js";
import type { ConfidenceEstimator } from "../agent-core/routing/confidence-estimator.js";
import type { MemoryRefresher } from "./memory-refresher.js";

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

  // Execute all tool calls
  const toolResults = await executeToolCalls(chatId, toolCalls, executeOptions);

  // Autonomy tracking
  trackAndRecordToolResults({
    chatId,
    toolCalls,
    toolResults,
    ...trackingParams,
  });

  return { toolResults };
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
        if (refreshed.newMemoryContext) {
          systemPrompt = replaceSection(
            systemPrompt,
            "re-retrieval:memory",
            `## Relevant Memory\n${refreshed.newMemoryContext}`,
          );
        }
        if (refreshed.newRagContext) {
          systemPrompt = replaceSection(
            systemPrompt,
            "re-retrieval:rag",
            refreshed.newRagContext,
          );
        }
        if (refreshed.newInsights?.length) {
          agentState = { ...agentState, learnedInsights: refreshed.newInsights };
        }
        if (refreshed.newInstinctIds?.length && onNewInstinctIds) {
          onNewInstinctIds(refreshed.newInstinctIds);
        }
      }
    }
  } catch {
    // Re-retrieval failure is non-fatal
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
): Promise<void> {
  if (!ctx.consensusManager || !ctx.confidenceEstimator) return;

  try {
    const taskClass = ctx.taskClassifier.classify(ctx.prompt);
    const confidence = ctx.confidenceEstimator.estimate({
      task: taskClass,
      providerName: ctx.currentAssignment.providerName,
      providerCapabilities: ctx.currentProviderCapabilities,
      agentState: ctx.agentState,
      responseLength: ctx.responseText.length,
    });
    await runConsensusVerification({
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
      identityKey: ctx.identityKey,
      logLabel: ctx.logLabel,
      recordExecutionTrace: ctx.recordExecutionTrace,
      recordPhaseOutcome: ctx.recordPhaseOutcome,
    });
  } catch {
    // Consensus failure is non-fatal
  }
}
