import { vi, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "./agents/orchestrator.js";
import { createMockChannel, createMockTool } from "./test-helpers.js";
import type { IChannelAdapter } from "./channels/channel.interface.js";
import type { IAIProvider, ProviderResponse, MessageContent } from "./agents/providers/provider.interface.js";
import type { ITool } from "./agents/tools/tool.interface.js";

vi.mock("./utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("./agents/context/strata-knowledge.js", () => ({
  STRATA_SYSTEM_PROMPT: "Test system prompt",
  buildProjectContext: vi.fn().mockReturnValue("\nProject context"),
  buildAnalysisSummary: vi.fn().mockReturnValue(""),
  buildDepsContext: vi.fn().mockReturnValue(""),
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
  let callCount = 0;
  return {
    name: "mock-integration",
    capabilities: defaultCapabilities,
    chat: vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
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

function createUnknownToolProvider() {
  let callCount = 0;
  return {
    name: "mock-unknown-tool",
    capabilities: defaultCapabilities,
    chat: vi.fn(async (): Promise<ProviderResponse> => {
      callCount++;
      if (callCount === 1) {
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
    vi.useFakeTimers();
    channel = createMockChannel();
    fileReadTool = createMockTool("file_read", { content: "using UnityEngine;\npublic class Test {}" });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    // Provider should have been called twice: once for the initial request, once after tool result
    expect(provider.chat).toHaveBeenCalledTimes(2);

    // Tool should have been executed with the correct input
    expect(fileReadTool.execute).toHaveBeenCalledWith(
      { path: "test.cs" },
      expect.objectContaining({ projectPath: "/test/project" })
    );

    // The second provider call should include the tool result in messages
    const secondCallMessages = vi.mocked(provider.chat).mock.calls[1]![1];
    const toolResults = findToolResultContent(secondCallMessages);
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
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    // Provider called once, no tool loop
    expect(provider.chat).toHaveBeenCalledTimes(1);

    // No tools executed
    expect(fileReadTool.execute).not.toHaveBeenCalled();

    // Direct response sent to the channel
    expect(channel.sendMarkdown).toHaveBeenCalledWith(
      "integration-2",
      "Hello! How can I help you?"
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
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    // Provider called twice: first returns unknown tool, second returns final text
    expect(provider.chat).toHaveBeenCalledTimes(2);

    // No actual tool was executed
    expect(fileReadTool.execute).not.toHaveBeenCalled();

    // Verify the error result was sent back in the second call
    const secondCallMessages = vi.mocked(provider.chat).mock.calls[1]![1];
    const toolResults = findToolResultContent(secondCallMessages);
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
