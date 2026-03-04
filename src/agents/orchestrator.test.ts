import { Orchestrator } from "./orchestrator.js";
import type { ProviderResponse } from "./providers/provider.interface.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("./context/strata-knowledge.js", () => ({
  STRATA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildDepsContext: () => "",
}));

function createMockProvider() {
  return {
    name: "mock",
    chat: vi.fn().mockResolvedValue({
      text: "Hello!",
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  };
}

function createMockChannel() {
  let messageHandler: ((msg: any) => Promise<void>) | null = null;
  return {
    name: "mock",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((handler: any) => { messageHandler = handler; }),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    isHealthy: vi.fn().mockReturnValue(true),
    _trigger: async (msg: any) => { if (messageHandler) await messageHandler(msg); },
  };
}

function createMockTool(name: string, isWrite = false) {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue({ content: `${name} result` }),
  };
}

describe("Orchestrator", () => {
  let mockProvider: ReturnType<typeof createMockProvider>;
  let mockChannel: ReturnType<typeof createMockChannel>;
  let readTool: ReturnType<typeof createMockTool>;
  let writeTool: ReturnType<typeof createMockTool>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();

    mockProvider = createMockProvider();
    mockChannel = createMockChannel();
    readTool = createMockTool("file_read");
    writeTool = createMockTool("file_write", true);

    orch = new Orchestrator({
      provider: mockProvider,
      tools: [readTool, writeTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends text response for a simple message", async () => {
    const promise = orch.handleMessage({
      channelType: "cli",
      chatId: "chat1",
      userId: "user1",
      text: "Hi there",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    expect(mockChannel.sendMarkdown).toHaveBeenCalledWith("chat1", "Hello!");
  });

  it("executes tool calls and loops back to provider", async () => {
    const toolResponse: ProviderResponse = {
      text: "Let me read that file...",
      toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30 },
    };
    const finalResponse: ProviderResponse = {
      text: "Here is the file content.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 60 },
    };

    mockProvider.chat
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    const promise = orch.handleMessage({
      channelType: "cli",
      chatId: "chat1",
      userId: "user1",
      text: "Read the file",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    expect(readTool.execute).toHaveBeenCalledWith(
      { path: "test.cs" },
      expect.objectContaining({ projectPath: "/tmp/test-project" }),
    );
    expect(mockChannel.sendMarkdown).toHaveBeenCalledWith("chat1", "Here is the file content.");
  });

  it("requests confirmation for write operations", async () => {
    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "file_write", input: { path: "output.cs" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30 },
    };
    const finalResponse: ProviderResponse = {
      text: "File written.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 60 },
    };

    mockProvider.chat
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    mockChannel.requestConfirmation.mockResolvedValue("Yes");

    const promise = orch.handleMessage({
      channelType: "cli",
      chatId: "chat1",
      userId: "user1",
      text: "Write the file",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockChannel.requestConfirmation).toHaveBeenCalled();
    expect(writeTool.execute).toHaveBeenCalled();
  });

  it("cancels write operation when user denies confirmation", async () => {
    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "file_write", input: { path: "output.cs" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30 },
    };
    const finalResponse: ProviderResponse = {
      text: "Understood.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 60 },
    };

    mockProvider.chat
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    mockChannel.requestConfirmation.mockResolvedValue("No");

    const promise = orch.handleMessage({
      channelType: "cli",
      chatId: "chat1",
      userId: "user1",
      text: "Write the file",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(writeTool.execute).not.toHaveBeenCalled();

    // Verify "Operation cancelled" is in the tool results sent back to provider
    const secondCallArgs = mockProvider.chat.mock.calls[1]!;
    const messages = secondCallArgs[1] as any[];
    // Tool results are now in content array with tool_result blocks
    const toolResultMsg = messages.find((m: any) => 
      m.role === "user" && Array.isArray(m.content)
    );
    const toolResultBlock = toolResultMsg?.content?.find((c: any) => 
      c.type === "tool_result"
    );
    expect(toolResultBlock?.content).toContain("Operation cancelled");
  });

  it("returns error result for unknown tool", async () => {
    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "nonexistent_tool", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30 },
    };
    const finalResponse: ProviderResponse = {
      text: "Noted.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 60 },
    };

    mockProvider.chat
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    const promise = orch.handleMessage({
      channelType: "cli",
      chatId: "chat1",
      userId: "user1",
      text: "Do something",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockProvider.chat).toHaveBeenCalledTimes(2);

    const secondCallArgs = mockProvider.chat.mock.calls[1]!;
    const messages = secondCallArgs[1] as any[];
    // Tool results are now in content array with tool_result blocks
    const toolResultMsg = messages.find((m: any) => 
      m.role === "user" && Array.isArray(m.content)
    );
    const toolResultBlock = toolResultMsg?.content?.find((c: any) => 
      c.type === "tool_result"
    );
    expect(toolResultBlock?.content).toContain("unknown tool");
    expect(toolResultBlock?.is_error).toBe(true);
  });

  it("returns error result when tool execution throws", async () => {
    readTool.execute.mockRejectedValueOnce(new Error("disk failure"));

    const toolResponse: ProviderResponse = {
      text: "",
      toolCalls: [{ id: "tc1", name: "file_read", input: { path: "bad.cs" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30 },
    };
    const finalResponse: ProviderResponse = {
      text: "Something went wrong.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 60 },
    };

    mockProvider.chat
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    const promise = orch.handleMessage({
      channelType: "cli",
      chatId: "chat1",
      userId: "user1",
      text: "Read the file",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const secondCallArgs = mockProvider.chat.mock.calls[1]!;
    const messages = secondCallArgs[1] as any[];
    // Tool results are now in content array with tool_result blocks
    const toolResultMsg = messages.find((m: any) => 
      m.role === "user" && Array.isArray(m.content)
    );
    const toolResultBlock = toolResultMsg?.content?.find((c: any) => 
      c.type === "tool_result"
    );
    expect(toolResultBlock?.content).toContain("Tool execution failed");
    expect(toolResultBlock?.is_error).toBe(true);
  });

  it("cleanupSessions removes expired sessions", async () => {
    // Create a session by handling a message
    const promise = orch.handleMessage({
      channelType: "cli",
      chatId: "old-session",
      userId: "user1",
      text: "Hello",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockProvider.chat).toHaveBeenCalledTimes(1);

    // Advance time past the default 1 hour session expiry
    vi.advanceTimersByTime(3_600_001);
    orch.cleanupSessions();

    // Sending another message to the same chatId creates a fresh session
    const promise2 = orch.handleMessage({
      channelType: "cli",
      chatId: "old-session",
      userId: "user1",
      text: "Hello again",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise2;

    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
  });

  describe("isWriteOperation", () => {
    // Access the private method through the orchestrator's behavior
    // by checking which tool names trigger confirmation

    it("treats file_write as a write operation", async () => {
      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_write", input: { path: "f.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
      const finalResponse: ProviderResponse = {
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      };

      mockProvider.chat
        .mockResolvedValueOnce(toolResponse)
        .mockResolvedValueOnce(finalResponse);

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "c1",
        userId: "u1",
        text: "write",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockChannel.requestConfirmation).toHaveBeenCalled();
    });

    it("does not treat file_read as a write operation", async () => {
      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "f.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
      const finalResponse: ProviderResponse = {
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      };

      mockProvider.chat
        .mockResolvedValueOnce(toolResponse)
        .mockResolvedValueOnce(finalResponse);

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "c2",
        userId: "u1",
        text: "read",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockChannel.requestConfirmation).not.toHaveBeenCalled();
    });

    it("treats create_system as a write operation", async () => {
      const systemTool = createMockTool("create_system", true);
      const orchWithSystemTool = new Orchestrator({
        provider: mockProvider,
        tools: [systemTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: true,
      });

      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "create_system", input: { name: "TestSystem" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
      const finalResponse: ProviderResponse = {
        text: "Created.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      };

      mockProvider.chat
        .mockResolvedValueOnce(toolResponse)
        .mockResolvedValueOnce(finalResponse);

      const promise = orchWithSystemTool.handleMessage({
        channelType: "cli",
        chatId: "c3",
        userId: "u1",
        text: "create system",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockChannel.requestConfirmation).toHaveBeenCalled();
    });
  });
});
