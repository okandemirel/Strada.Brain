import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockChannel, createMockProvider, createMockTool } from "../test-helpers.js";
import type { IChannelAdapter } from "../channels/channel.interface.js";
import type { IAIProvider, ProviderResponse } from "./providers/provider.interface.js";
import type { ITool } from "./tools/tool.interface.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("./context/strata-knowledge.js", () => ({
  STRATA_SYSTEM_PROMPT: "Test system prompt",
  buildProjectContext: vi.fn().mockReturnValue("\nProject context"),
}));

describe("Orchestrator", () => {
  let channel: IChannelAdapter;
  let provider: IAIProvider;
  let tool: ITool;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    channel = createMockChannel();
    provider = createMockProvider();
    tool = createMockTool("file_read");

    orchestrator = new Orchestrator({
      provider,
      tools: [tool],
      channel,
      projectPath: "/test/project",
      readOnly: false,
      requireConfirmation: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends text response for end_turn", async () => {
    const promise = orchestrator.handleMessage({
      channelType: "telegram",
      chatId: "chat1",
      userId: "user1",
      text: "Hello",
      timestamp: new Date(),
    });
    // Advance past any timers
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(channel.sendMarkdown).toHaveBeenCalledWith("chat1", "Mock response");
  });

  it("executes tool calls and loops", async () => {
    const toolResponse: ProviderResponse = {
      text: "Using tool...",
      toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const finalResponse: ProviderResponse = {
      text: "Done!",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 150, outputTokens: 60 },
    };

    vi.mocked(provider.chat)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    const promise = orchestrator.handleMessage({
      channelType: "cli", chatId: "c1", userId: "u1", text: "read file", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(tool.execute).toHaveBeenCalledWith(
      { path: "test.cs" },
      expect.objectContaining({ projectPath: "/test/project" })
    );
    expect(channel.sendMarkdown).toHaveBeenCalledWith("c1", "Done!");
  });

  it("returns error for unknown tool", async () => {
    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "unknown_tool", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const finalResponse: ProviderResponse = {
      text: "Noted.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 150, outputTokens: 60 },
    };

    vi.mocked(provider.chat)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    const promise = orchestrator.handleMessage({
      channelType: "cli", chatId: "c1", userId: "u1", text: "x", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(provider.chat).toHaveBeenCalledTimes(2);
    // Verify the second call includes an error tool result for the unknown tool
    const secondCallArgs = vi.mocked(provider.chat).mock.calls[1]!;
    const messages = secondCallArgs[1];
    const toolResultMsg = messages.find((m) => m.toolResults?.length);
    expect(toolResultMsg?.toolResults?.[0]?.content).toContain("unknown tool");
    expect(toolResultMsg?.toolResults?.[0]?.isError).toBe(true);
  });

  it("handles tool execution errors gracefully", async () => {
    vi.mocked(tool.execute).mockRejectedValue(new Error("tool crash"));

    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "file_read", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const finalResponse: ProviderResponse = {
      text: "Error occurred.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 150, outputTokens: 60 },
    };

    vi.mocked(provider.chat)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    const promise = orchestrator.handleMessage({
      channelType: "cli", chatId: "c1", userId: "u1", text: "x", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(provider.chat).toHaveBeenCalledTimes(2);
    // Verify the second call includes an error tool result for the failed execution
    const secondCallArgs = vi.mocked(provider.chat).mock.calls[1]!;
    const messages = secondCallArgs[1];
    const toolResultMsg = messages.find((m) => m.toolResults?.length);
    expect(toolResultMsg?.toolResults?.[0]?.content).toContain("Tool execution failed");
    expect(toolResultMsg?.toolResults?.[0]?.isError).toBe(true);
  });

  it("sends generic error to user on agent loop failure", async () => {
    vi.mocked(provider.chat).mockRejectedValue(new Error("API crash"));

    const promise = orchestrator.handleMessage({
      channelType: "cli", chatId: "c1", userId: "u1", text: "x", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(channel.sendText).toHaveBeenCalledWith("c1", expect.stringContaining("error occurred"));
  });

  it("asks for write confirmation when enabled", async () => {
    const writeTool = createMockTool("file_write");
    const orch = new Orchestrator({
      provider,
      tools: [writeTool],
      channel,
      projectPath: "/test",
      readOnly: false,
      requireConfirmation: true,
    });

    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "file_write", input: { path: "test.cs" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const finalResponse: ProviderResponse = {
      text: "Written.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 150, outputTokens: 60 },
    };

    vi.mocked(provider.chat)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);
    vi.mocked(channel.requestConfirmation).mockResolvedValue("Yes");

    const promise = orch.handleMessage({
      channelType: "cli", chatId: "c1", userId: "u1", text: "write", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(channel.requestConfirmation).toHaveBeenCalled();
    expect(writeTool.execute).toHaveBeenCalled();
  });

  it("cancels write operation when user declines", async () => {
    const writeTool = createMockTool("file_write");
    const orch = new Orchestrator({
      provider,
      tools: [writeTool],
      channel,
      projectPath: "/test",
      readOnly: false,
      requireConfirmation: true,
    });

    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "file_write", input: { path: "test.cs" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const finalResponse: ProviderResponse = {
      text: "OK.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 150, outputTokens: 60 },
    };

    vi.mocked(provider.chat)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);
    vi.mocked(channel.requestConfirmation).mockResolvedValue("No");

    const promise = orch.handleMessage({
      channelType: "cli", chatId: "c1", userId: "u1", text: "write", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(writeTool.execute).not.toHaveBeenCalled();
  });

  it("evicts oldest session when exceeding MAX_SESSIONS", async () => {
    // Create 101 sessions to trigger eviction
    for (let i = 0; i < 101; i++) {
      const promise = orchestrator.handleMessage({
        channelType: "cli", chatId: `chat${i}`, userId: "u1", text: "hi", timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(10);
      await promise;
    }
    // No error should have occurred — eviction happens silently
    expect(provider.chat).toHaveBeenCalledTimes(101);
  });

  it("cleans up expired sessions", async () => {
    const promise = orchestrator.handleMessage({
      channelType: "cli", chatId: "old-chat", userId: "u1", text: "hi", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    // Advance time past session expiry (default 1h)
    vi.advanceTimersByTime(3600_001);
    orchestrator.cleanupSessions();

    // New message to same chatId should work (creates new session)
    const promise2 = orchestrator.handleMessage({
      channelType: "cli", chatId: "old-chat", userId: "u1", text: "hi again", timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise2;
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });
});

describe("sanitizeToolResult (via Orchestrator)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function createSanitizeTestOrch(toolContent: string) {
    const channel = createMockChannel();
    const tool = createMockTool("file_read", { content: toolContent });
    const provider = createMockProvider();

    vi.mocked(provider.chat)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 50 },
      })
      .mockResolvedValueOnce({
        text: "Done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
      });

    const orch = new Orchestrator({
      provider, tools: [tool], channel,
      projectPath: "/test", readOnly: false, requireConfirmation: false,
    });

    return { orch, provider };
  }

  async function getSanitizedContent(toolContent: string): Promise<string> {
    const { orch, provider } = createSanitizeTestOrch(toolContent);
    await orch.handleMessage({
      channelType: "cli", chatId: "c1", userId: "u1", text: "read", timestamp: new Date(),
    });
    const secondCallArgs = vi.mocked(provider.chat).mock.calls[1]!;
    const messages = secondCallArgs[1];
    const toolResultMsg = messages.find((m) => m.toolResults?.length);
    return toolResultMsg?.toolResults?.[0]?.content ?? "";
  }

  it("strips sk- API key patterns", async () => {
    const content = await getSanitizedContent("Found key: sk-ant-1234567890abcdef in config");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("sk-ant-1234567890");
  });

  it("strips key- patterns", async () => {
    const content = await getSanitizedContent("key-abc1234567890xyz");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("key-abc1234567890");
  });

  it("strips token- patterns", async () => {
    const content = await getSanitizedContent("token-xyz1234567890abc");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("token-xyz1234567890");
  });

  it("truncates results exceeding 8192 chars", async () => {
    const content = await getSanitizedContent("x".repeat(9000));
    expect(content).toContain("(truncated)");
    expect(content.length).toBeLessThan(9000);
  });
});
