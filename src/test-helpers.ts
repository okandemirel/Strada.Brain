import { vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IChannelAdapter } from "./channels/channel.interface.js";
import type { IAIProvider, ConversationMessage, ToolDefinition, ProviderResponse } from "./agents/providers/provider.interface.js";
import type { ITool, ToolContext, ToolExecutionResult } from "./agents/tools/tool.interface.js";
import type { IdentityState } from "./identity/identity-state.js";
import type { GoalTree } from "./goals/types.js";
import type { GoalNodeId } from "./goals/types.js";
import type { EmbeddingProvider, VectorStore } from "./vault/embedding-adapter.js";
import type { IVault } from "./vault/vault.interface.js";

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
 * Track temp directories across a suite for deferred cleanup (afterEach /
 * afterAll). Useful when resources (e.g. sqlite handles) must be disposed
 * before removal, so per-test withTempDir() does not fit.
 */
export function createTempDirTracker(defaultPrefix = "strada-test-"): {
  makeDir: (prefix?: string) => string;
  cleanup: () => void;
} {
  const dirs: string[] = [];
  return {
    makeDir(prefix = defaultPrefix): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Create a fake EmbeddingProvider that returns a constant unit vector.
 */
export function createFakeEmbedding(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    model: "fake-embed",
    dim: 4,
    embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    ...overrides,
  };
}

/**
 * Create an in-memory fake VectorStore.
 */
export function createFakeVectorStore(): VectorStore {
  let next = 1;
  const items = new Map<number, { payload: unknown }>();
  return {
    add: (_v, payload) => { const id = next++; items.set(id, { payload }); return id; },
    remove: (id) => { items.delete(id); },
    search: (_v, k) => [...items.entries()].slice(0, k).map(([id, e]) => ({ id, score: 1, payload: e.payload })),
    clear: () => items.clear(),
  };
}

/**
 * Create a fake IVault with vi.fn() stubs for every required method.
 */
export function createFakeVault(overrides: Partial<IVault> = {}): IVault {
  return {
    id: "unity:abc12345",
    kind: "unity-project",
    rootPath: "/tmp/fake-root",
    init: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({ changed: 0, durationMs: 1 })),
    rebuild: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ hits: [], budgetUsed: 0, truncated: false })),
    stats: vi.fn(async () => ({ fileCount: 1, chunkCount: 2, lastIndexedAt: 123, dbBytes: 10 })),
    dispose: vi.fn(async () => undefined),
    listFiles: vi.fn(() => []),
    readFile: vi.fn(async () => "body"),
    onUpdate: vi.fn(() => () => undefined),
    ...overrides,
  };
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
