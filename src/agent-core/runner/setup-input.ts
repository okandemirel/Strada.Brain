/**
 * The run request projected onto the setup input the orchestrator port reads
 * (V2AgentRunner's spine-local glue, moved beside it: no logic, a pure shape
 * adapter). `instinctOwner` travels with `userId`: setup retrieves instincts
 * for it, and every other identity reader keeps `userId`.
 */
import type { AgentRunRequest, RunnerMode } from "./agent-runner.js";
import type { AgentRunSetupInput } from "./orchestrator-port.js";

export function setupInputOf(request: AgentRunRequest, mode: RunnerMode): AgentRunSetupInput {
  return {
    prompt: request.prompt,
    chatId: request.chatId,
    channelType: String(request.channelType),
    userId: request.userId,
    instinctOwner: request.instinctOwner,
    conversationId: request.conversationId,
    attachments: request.attachments,
    userContent: request.userContent,
    mode,
    interactiveSession: request.interactiveSession,
    assignedProvider: request.assignedProvider,
    assignedModel: request.assignedModel,
    taskRunId: request.taskRunId,
    parentMetricId: request.parentMetricId,
    onUsage: request.onUsage,
    workspaceLease: request.workspaceLease,
    workspaceLeaseRetained: request.workspaceLeaseRetained,
    workspacePolicy: request.workspacePolicy,
    goalContext: request.goalContext,
    monitorScope: request.monitorScope,
  };
}
