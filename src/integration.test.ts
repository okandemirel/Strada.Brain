import { vi, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "./agents/orchestrator.js";
import { createMockChannel, createMockTool } from "./test-helpers.js";
import type { IChannelAdapter } from "./channels/channel.interface.js";
import type { IAIProvider, ProviderResponse, MessageContent } from "./agents/providers/provider.interface.js";
import type { ITool } from "./agents/tools/tool.interface.js";

vi.mock("./utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getLogRingBuffer: () => [],
}));

vi.mock("./agents/context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt",
  buildProjectContext: vi.fn().mockReturnValue("\nProject context"),
  buildAnalysisSummary: vi.fn().mockReturnValue(""),
  buildProjectWorldMemorySection: vi.fn().mockImplementation((params: { projectPath: string; analysis?: { modules?: Array<{ name: string }> } | null }) => ({
    content: `## Project/World Memory\nActive project root: ${params.projectPath}\n${params.analysis?.modules?.[0]?.name ?? "No cached analysis"}`,
    contentHashes: [params.projectPath, params.analysis?.modules?.[0]?.name ?? "No cached analysis"],
    summary: `root=${params.projectPath} | modules=${params.analysis?.modules?.[0]?.name ?? "none"}`,
    fingerprint: `root ${params.projectPath.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase()} modules ${(params.analysis?.modules?.[0]?.name ?? "none").toLowerCase()}`,
  })),
  buildDepsContext: vi.fn().mockReturnValue(""),
  buildCapabilityManifest: vi.fn().mockReturnValue(""),
  buildToolUsageHints: vi.fn().mockReturnValue(""),
}));

const defaultCapabilities = {
  maxTokens: 4096,
  streaming: false,
  structuredStreaming: false,
  toolCalling: true,
  vision: false,
  systemPrompt: true,
};

function createMockProvider() {
  // v2 PAOR semantics: call #1 is the PLANNING turn (its text is the plan, not the answer);
  // the tool turn and the final answer follow. v1's call-count script shifted by one.
  let callCount = 0;
  return {
    name: "mock-integration",
    capabilities: defaultCapabilities,
    chat: vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "Plan: read the file, then answer.",
          toolCalls: [],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
        };
      }
      if (callCount === 2) {
        return {
          text: "Let me read that file.",
          toolCalls: [{ id: "tc-1", name: "file_read", input: { path: "test.cs" } }],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
        };
      }
      return {
        text: "Here is the content of the file.",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
      };
    }),
  };
}

function createSimpleProvider() {
  return {
    name: "mock-simple",
    capabilities: defaultCapabilities,
    chat: vi.fn(async (): Promise<ProviderResponse> => ({
      text: "Hello! How can I help you?",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
    })),
  };
}

function createReasoningLeakProvider() {
  return {
    name: "mock-reasoning-leak",
    capabilities: defaultCapabilities,
    chat: vi.fn(async (): Promise<ProviderResponse> => ({
      text: "<reasoning>\ninternal-only\n</reasoning>\n\nVisible answer.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
    })),
  };
}

function createUnknownToolProvider() {
  // v2 PAOR semantics: call #1 = PLANNING; the unknown-tool call comes on the EXECUTING turn.
  let callCount = 0;
  return {
    name: "mock-unknown-tool",
    capabilities: defaultCapabilities,
    chat: vi.fn(async (): Promise<ProviderResponse> => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "Plan: try the special tool.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        };
      }
      if (callCount === 2) {
        return {
          text: "Let me try that.",
          toolCalls: [{ id: "tc-bad", name: "nonexistent_tool", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
        };
      }
      return {
        text: "Sorry, I could not find that tool.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 60, outputTokens: 25, totalTokens: 85 },
      };
    }),
  };
}

// Helper to find tool result content blocks in messages
function findToolResultContent(messages: { content?: string | MessageContent[] }[]): Array<{ tool_use_id: string; content: string; is_error?: boolean }> {
  const results: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
  for (const msg of messages) {
    if (msg.content && typeof msg.content !== "string") {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          results.push(block);
        }
      }
    }
  }
  return results;
}

describe("Integration: full message flow", () => {
  let channel: IChannelAdapter;
  let fileReadTool: ITool;

  beforeEach(() => {
    channel = createMockChannel();
    fileReadTool = createMockTool("file_read", { content: "using UnityEngine;\npublic class Test {}" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("handles tool call round-trip: user -> provider -> tool -> provider -> channel", async () => {
    const provider = createMockProvider();

    const orchestrator = new Orchestrator({
      providerManager: { getProvider: () => provider, shutdown: vi.fn() } as any,
      tools: [fileReadTool],
      channel,
      projectPath: "/test/project",
      readOnly: false,
      requireConfirmation: false,
    });

    const promise = orchestrator.handleMessage({
      channelType: "cli",
      chatId: "integration-1",
      userId: "user-1",
      text: "Read the file at Assets/test.cs",
      timestamp: new Date(),
    });
    await promise;

    // v2 PAOR: PLANNING + tool turn + post-tool answer — at least three provider calls.
    expect(provider.chat.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Tool should have been executed with the correct input
    expect(fileReadTool.execute).toHaveBeenCalledWith(
      { path: "test.cs" },
      expect.objectContaining({ projectPath: "/test/project" })
    );

    // A later provider call includes the tool result in its messages (v2: the post-tool turn).
    const lastCallMessages = vi.mocked(provider.chat).mock.calls.at(-1)![1];
    const toolResults = findToolResultContent(lastCallMessages);
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults[0]!.content).toContain("using UnityEngine");

    // Final response should be sent to the channel
    expect(channel.sendMarkdown).toHaveBeenCalledWith(
      "integration-1",
      "Here is the content of the file."
    );
  });

  it("handles simple text response without tool calls", async () => {
    const provider = createSimpleProvider();

    const orchestrator = new Orchestrator({
      providerManager: { getProvider: () => provider, shutdown: vi.fn() } as any,
      tools: [fileReadTool],
      channel,
      projectPath: "/test/project",
      readOnly: false,
      requireConfirmation: false,
    });

    const promise = orchestrator.handleMessage({
      channelType: "cli",
      chatId: "integration-2",
      userId: "user-1",
      text: "Hello",
      timestamp: new Date(),
    });
    await promise;

    // v2 PAOR: PLANNING + EXECUTING — two calls, no tool loop.
    expect(provider.chat).toHaveBeenCalledTimes(2);

    // No tools executed
    expect(fileReadTool.execute).not.toHaveBeenCalled();

    // Direct response sent to the channel
    expect(channel.sendMarkdown).toHaveBeenCalledWith(
      "integration-2",
      "Hello! How can I help you?"
    );
  });

  it("does not leak provider reasoning blocks to the CLI-visible response", async () => {
    const provider = createReasoningLeakProvider();

    const orchestrator = new Orchestrator({
      providerManager: { getProvider: () => provider, shutdown: vi.fn() } as any,
      tools: [fileReadTool],
      channel,
      projectPath: "/test/project",
      readOnly: false,
      requireConfirmation: false,
    });

    const promise = orchestrator.handleMessage({
      channelType: "cli",
      chatId: "integration-reasoning",
      userId: "user-1",
      text: "Explain briefly",
      timestamp: new Date(),
    });
    await promise;

    expect(channel.sendMarkdown).toHaveBeenCalledWith(
      "integration-reasoning",
      "Visible answer."
    );
  });

  it("handles unknown tool call by sending error result back to provider", async () => {
    const provider = createUnknownToolProvider();

    const orchestrator = new Orchestrator({
      providerManager: { getProvider: () => provider, shutdown: vi.fn() } as any,
      tools: [fileReadTool],
      channel,
      projectPath: "/test/project",
      readOnly: false,
      requireConfirmation: false,
    });

    const promise = orchestrator.handleMessage({
      channelType: "cli",
      chatId: "integration-3",
      userId: "user-1",
      text: "Do something special",
      timestamp: new Date(),
    });
    await promise;

    // v2 PAOR: PLANNING + the unknown-tool turn + recovery calls after the error result.
    expect(provider.chat.mock.calls.length).toBeGreaterThanOrEqual(3);

    // No actual tool was executed
    expect(fileReadTool.execute).not.toHaveBeenCalled();

    // Verify the error result was sent back on a later call (v2: after the EXECUTING turn).
    const lastCallMessages2 = vi.mocked(provider.chat).mock.calls.at(-1)![1];
    const toolResults = findToolResultContent(lastCallMessages2);
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults[0]!.content).toContain("unknown tool");
    expect(toolResults[0]!.is_error).toBe(true);

    // Final response acknowledging the error is sent to the channel
    expect(channel.sendMarkdown).toHaveBeenCalledWith(
      "integration-3",
      "Sorry, I could not find that tool."
    );
  });
});
