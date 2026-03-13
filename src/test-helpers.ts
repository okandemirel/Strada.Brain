import { vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IChannelAdapter } from "./channels/channel.interface.js";
import type { IAIProvider, ConversationMessage, ToolDefinition, ProviderResponse } from "./agents/providers/provider.interface.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./agents/tools/tool.interface.js";
import type { IdentityState } from "./identity/identity-state.js";
import type { GoalTree } from "./goals/types.js";
import type { GoalNodeId } from "./goals/types.js";

/**
 * Create a mock logger matching winston's interface.
 */
export function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Create a mock IChannelAdapter.
 */
export function createMockChannel(): IChannelAdapter {
  return {
    name: "mock",
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn<(chatId: string, text: string) => Promise<void>>().mockResolvedValue(undefined),
    sendMarkdown: vi.fn<(chatId: string, markdown: string) => Promise<void>>().mockResolvedValue(undefined),
    isHealthy: vi.fn<() => boolean>().mockReturnValue(true),
  };
}

/**
 * Create a mock IAIProvider.
 */
export function createMockProvider(response?: Partial<ProviderResponse>): IAIProvider {
  const defaultResponse: ProviderResponse = {
    text: "Mock response",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    ...response,
  };

  return {
    name: "mock-provider",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn<(sp: string, msgs: ConversationMessage[], tools: ToolDefinition[]) => Promise<ProviderResponse>>()
      .mockResolvedValue(defaultResponse),
  };
}

/**
 * Create a mock ITool.
 */
export function createMockTool(
  name: string,
  result?: Partial<ToolExecutionResult>
): ITool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: vi.fn<(input: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>>()
      .mockResolvedValue({ content: `${name} result`, ...result }),
  };
}

/**
 * Create a default ToolContext for testing.
 */
export function createToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    projectPath: "/test/project",
    workingDirectory: "/test/project",
    readOnly: false,
    ...overrides,
  };
}

/**
 * Run a test function with a temporary directory, cleaning up after.
 */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "strada-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Create a sample IdentityState for testing.
 */
export function makeIdentityState(overrides?: Partial<IdentityState>): IdentityState {
  return {
    agentUuid: "550e8400-e29b-41d4-a716-446655440000",
    agentName: "Strada Brain",
    firstBootTs: 1709856000000,
    bootCount: 5,
    cumulativeUptimeMs: 5580000,
    lastActivityTs: 1709942400000,
    totalMessages: 42,
    totalTasks: 10,
    projectContext: "/projects/MyGame",
    cleanShutdown: true,
    ...overrides,
  };
}

/**
 * Create a sample GoalTree for testing.
 */
export function makeGoalTree(taskDescription: string): GoalTree {
  const rootId = "goal_test_root" as GoalNodeId;
  return {
    rootId,
    sessionId: "session-1",
    taskDescription,
    nodes: new Map([
      [
        rootId,
        {
          id: rootId,
          parentId: null,
          task: taskDescription,
          dependsOn: [] as readonly GoalNodeId[],
          depth: 0,
          status: "executing" as const,
          createdAt: Date.now() - 600000,
          updatedAt: Date.now() - 300000,
        },
      ],
    ]),
    createdAt: Date.now() - 600000,
  };
}
