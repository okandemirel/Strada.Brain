import { Orchestrator } from "./orchestrator.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import type { IEventEmitter, LearningEventMap, ToolResultEvent } from "../core/event-bus.js";

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
  buildCapabilityManifest: () => "\n## Agent Capability Manifest\nGoal Decomposition\nLearning Pipeline\nIntrospection\n",
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
      providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
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

    // PAOR reflection may add extra calls after error
    expect(mockProvider.chat.mock.calls.length).toBeGreaterThanOrEqual(2);

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

  describe("Capability Manifest", () => {
    it("includes capability manifest in system prompt sent to provider", async () => {
      const chatSpy = vi.fn().mockResolvedValueOnce({
        text: "Hello!",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      mockProvider.chat = chatSpy;

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "manifest-check",
        userId: "user1",
        text: "What can you do?",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      const systemPromptArg = chatSpy.mock.calls[0]![0] as string;
      expect(systemPromptArg).toContain("Agent Capability Manifest");
      expect(systemPromptArg).toContain("Goal Decomposition");
      expect(systemPromptArg).toContain("Learning Pipeline");
      expect(systemPromptArg).toContain("Introspection");
    });
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
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
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

  describe("Event Emission", () => {
    it("should accept optional eventEmitter parameter", () => {
      const mockEmitter: IEventEmitter<LearningEventMap> = {
        emit: vi.fn(),
      };

      expect(() => new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        eventEmitter: mockEmitter,
      })).not.toThrow();
    });

    it("should emit tool:result event for each tool call result", async () => {
      const emittedEvents: ToolResultEvent[] = [];
      const mockEmitter: IEventEmitter<LearningEventMap> = {
        emit: vi.fn((_event: string, payload: ToolResultEvent) => {
          emittedEvents.push(payload);
        }),
      };

      const orchWithEmitter = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        eventEmitter: mockEmitter,
      });

      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
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

      const promise = orchWithEmitter.handleMessage({
        channelType: "cli",
        chatId: "event1",
        userId: "user1",
        text: "Read file",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockEmitter.emit).toHaveBeenCalledWith("tool:result", expect.objectContaining({
        toolName: "file_read",
        success: true,
      }));
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]!.toolName).toBe("file_read");
      expect(emittedEvents[0]!.success).toBe(true);
      expect(emittedEvents[0]!.timestamp).toBeGreaterThan(0);
    });

    it("should include correct fields in event payload", async () => {
      const emittedEvents: ToolResultEvent[] = [];
      const mockEmitter: IEventEmitter<LearningEventMap> = {
        emit: vi.fn((_event: string, payload: ToolResultEvent) => {
          emittedEvents.push(payload);
        }),
      };

      const orchWithEmitter = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        eventEmitter: mockEmitter,
      });

      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
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

      const promise = orchWithEmitter.handleMessage({
        channelType: "cli",
        chatId: "event2",
        userId: "user1",
        text: "Read file",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      const event = emittedEvents[0]!;
      expect(event).toHaveProperty("sessionId");
      expect(event).toHaveProperty("toolName");
      expect(event).toHaveProperty("input");
      expect(event).toHaveProperty("output");
      expect(event).toHaveProperty("success");
      expect(event).toHaveProperty("timestamp");
    });

    it("should not throw when eventEmitter is not provided", async () => {
      // orch created without eventEmitter in beforeEach
      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
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
        chatId: "noevent",
        userId: "user1",
        text: "Read file",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe("appliedInstinctIds Wiring", () => {
    it("should include appliedInstinctIds in tool:result events when instincts are matched", async () => {
      const emittedEvents: ToolResultEvent[] = [];
      const mockEmitter: IEventEmitter<LearningEventMap> = {
        emit: vi.fn((_event: string, payload: ToolResultEvent) => {
          emittedEvents.push(payload);
        }),
      };

      // Mock InstinctRetriever that returns matched instinct IDs
      const mockRetriever = {
        getInsightsForTask: vi.fn().mockResolvedValue({
          insights: "Some insights",
          matchedInstinctIds: ["instinct_abc_123", "instinct_def_456"],
        }),
      };

      const orchWithIds = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        eventEmitter: mockEmitter,
        instinctRetriever: mockRetriever as any,
      });

      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
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

      const promise = orchWithIds.handleMessage({
        channelType: "cli",
        chatId: "ids1",
        userId: "user1",
        text: "Read file",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]!.appliedInstinctIds).toEqual(["instinct_abc_123", "instinct_def_456"]);
    });

    it("should send empty array when no instincts are matched", async () => {
      const emittedEvents: ToolResultEvent[] = [];
      const mockEmitter: IEventEmitter<LearningEventMap> = {
        emit: vi.fn((_event: string, payload: ToolResultEvent) => {
          emittedEvents.push(payload);
        }),
      };

      // No instinctRetriever provided
      const orchNoRetriever = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        eventEmitter: mockEmitter,
      });

      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
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

      const promise = orchNoRetriever.handleMessage({
        channelType: "cli",
        chatId: "ids2",
        userId: "user1",
        text: "Read file",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]!.appliedInstinctIds).toEqual([]);
    });

    it("should capture appliedInstinctIds per-message (not shared across sessions)", async () => {
      const emittedEvents: ToolResultEvent[] = [];
      const mockEmitter: IEventEmitter<LearningEventMap> = {
        emit: vi.fn((_event: string, payload: ToolResultEvent) => {
          emittedEvents.push(payload);
        }),
      };

      let callCount = 0;
      const mockRetriever = {
        getInsightsForTask: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({
            insights: "insights",
            matchedInstinctIds: callCount === 1 ? ["instinct_first"] : ["instinct_second"],
          });
        }),
      };

      const orchPerMessage = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        eventEmitter: mockEmitter,
        instinctRetriever: mockRetriever as any,
      });

      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
      const finalResponse: ProviderResponse = {
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      };

      // First message
      mockProvider.chat
        .mockResolvedValueOnce(toolResponse)
        .mockResolvedValueOnce(finalResponse);

      const promise1 = orchPerMessage.handleMessage({
        channelType: "cli",
        chatId: "ids3a",
        userId: "user1",
        text: "First message",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise1;

      // Second message
      mockProvider.chat
        .mockResolvedValueOnce({ ...toolResponse, toolCalls: [{ id: "tc2", name: "file_read", input: { path: "other.cs" } }] })
        .mockResolvedValueOnce(finalResponse);

      const promise2 = orchPerMessage.handleMessage({
        channelType: "cli",
        chatId: "ids3b",
        userId: "user1",
        text: "Second message",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise2;

      // Each message should have its own instinct IDs
      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[0]!.appliedInstinctIds).toEqual(["instinct_first"]);
      expect(emittedEvents[1]!.appliedInstinctIds).toEqual(["instinct_second"]);
    });
  });

  describe("Goal Detection Short-Circuit", () => {
    it("submits goal via taskManager when LLM response contains valid goal block", async () => {
      const mockTaskManager = {
        submit: vi.fn().mockReturnValue({ id: "task_abc123" }),
      };

      const goalOrch = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });
      goalOrch.setTaskManager(mockTaskManager as any);

      // LLM returns a plan with a goal block
      const planWithGoal = `Plan:
1. Set up database schema
2. Create API endpoints
3. Add authentication

\`\`\`goal
{"isGoal": true, "estimatedMinutes": 5, "nodes": [{"id": "s1", "task": "Set up database schema", "dependsOn": []}, {"id": "s2", "task": "Create API endpoints", "dependsOn": ["s1"]}, {"id": "s3", "task": "Add authentication", "dependsOn": ["s2"]}]}
\`\`\``;

      mockProvider.chat.mockResolvedValueOnce({
        text: planWithGoal,
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 50, outputTokens: 100 },
      });

      const promise = goalOrch.handleMessage({
        channelType: "cli",
        chatId: "goal-detect-1",
        userId: "user1",
        text: "Build a REST API with database and auth",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Should have submitted via taskManager with goalTree
      expect(mockTaskManager.submit).toHaveBeenCalledWith(
        "goal-detect-1",
        "cli",
        "Build a REST API with database and auth",
        expect.objectContaining({ goalTree: expect.any(Object) }),
      );
    });

    it("continues normal PAOR when no goal block in response", async () => {
      const mockTaskManager = {
        submit: vi.fn(),
      };

      const goalOrch = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });
      goalOrch.setTaskManager(mockTaskManager as any);

      // LLM returns a simple response (no goal block)
      mockProvider.chat.mockResolvedValueOnce({
        text: "Hello! How can I help you today?",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      const promise = goalOrch.handleMessage({
        channelType: "cli",
        chatId: "goal-detect-2",
        userId: "user1",
        text: "What is TypeScript?",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // TaskManager should NOT have been called
      expect(mockTaskManager.submit).not.toHaveBeenCalled();
      // Normal response sent
      expect(mockChannel.sendMarkdown).toHaveBeenCalledWith("goal-detect-2", "Hello! How can I help you today?");
    });

    it("sends acknowledgment message before submitting goal", async () => {
      const mockTaskManager = {
        submit: vi.fn().mockReturnValue({ id: "task_def456" }),
      };

      const goalOrch = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });
      goalOrch.setTaskManager(mockTaskManager as any);

      const planWithGoal = `Plan with goal:
\`\`\`goal
{"isGoal": true, "estimatedMinutes": 10, "nodes": [{"id": "s1", "task": "Step one", "dependsOn": []}]}
\`\`\``;

      mockProvider.chat.mockResolvedValueOnce({
        text: planWithGoal,
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 50, outputTokens: 100 },
      });

      const promise = goalOrch.handleMessage({
        channelType: "cli",
        chatId: "goal-detect-3",
        userId: "user1",
        text: "Deploy the application",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Acknowledgment should have been sent via sendText before submit
      expect(mockChannel.sendText).toHaveBeenCalledWith(
        "goal-detect-3",
        expect.stringContaining("Deploy the application"),
      );
      // And it should mention steps and estimated time
      const ackCall = mockChannel.sendText.mock.calls.find(
        (c: any[]) => c[0] === "goal-detect-3" && c[1].includes("step"),
      );
      expect(ackCall).toBeDefined();
    });

    it("returns immediately after goal submission (short-circuit)", async () => {
      const mockTaskManager = {
        submit: vi.fn().mockReturnValue({ id: "task_ghi789" }),
      };

      const goalOrch = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });
      goalOrch.setTaskManager(mockTaskManager as any);

      const planWithGoal = `Plan:
\`\`\`goal
{"isGoal": true, "estimatedMinutes": 3, "nodes": [{"id": "s1", "task": "Do stuff", "dependsOn": []}]}
\`\`\``;

      mockProvider.chat.mockResolvedValueOnce({
        text: planWithGoal,
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 50, outputTokens: 100 },
      });

      const promise = goalOrch.handleMessage({
        channelType: "cli",
        chatId: "goal-detect-4",
        userId: "user1",
        text: "Build something complex",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Only one LLM call (plan phase) -- no EXECUTING phase
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      // TaskManager was called
      expect(mockTaskManager.submit).toHaveBeenCalledTimes(1);
    });
  });

  describe("PAOR State Machine", () => {
    it("injects planning prompt on first call", async () => {
      const chatSpy = vi.fn()
        .mockResolvedValueOnce({
          text: "Plan:\n1. Read file\n2. Fix error",
          toolCalls: [{ id: "tc1", name: "file_read", input: { path: "test.cs" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "Done!",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        });

      mockProvider.chat = chatSpy;

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "paor1",
        userId: "user1",
        text: "Fix the error",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      const firstCallPrompt = chatSpy.mock.calls[0]![0] as string;
      expect(firstCallPrompt).toContain("PLAN");
    });

    it("transitions to reflecting after tool errors", async () => {
      const buildTool = createMockTool("dotnet_build");
      buildTool.execute = vi.fn().mockResolvedValue({
        content: "error CS0103: 'Foo' does not exist",
        isError: true,
      });

      const orchWithBuild = new Orchestrator({
        providerManager: {
          getProvider: () => mockProvider,
          getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
          shutdown: vi.fn(),
        } as any,
        tools: [readTool, writeTool, buildTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const chatSpy = vi.fn()
        .mockResolvedValueOnce({
          text: "Plan: 1. Build project",
          toolCalls: [{ id: "tc1", name: "dotnet_build", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "CONTINUE - let me try a different fix",
          toolCalls: [{ id: "tc2", name: "file_read", input: { path: "test.cs" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "Fixed!",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        });

      mockProvider.chat = chatSpy;

      const promise = orchWithBuild.handleMessage({
        channelType: "cli",
        chatId: "paor2",
        userId: "user1",
        text: "Build the project",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      const secondCallMessages = chatSpy.mock.calls[1]![1] as any[];
      const hasReflection = secondCallMessages.some(
        (m: any) =>
          (typeof m.content === "string" && m.content.includes("Reflection Phase")) ||
          (Array.isArray(m.content) &&
            m.content.some((c: any) => c.text?.includes?.("Reflection Phase"))),
      );
      expect(hasReflection).toBe(true);
      expect(chatSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("MetricsRecorder Integration", () => {
    function createMockRecorder() {
      return {
        startTask: vi.fn().mockReturnValue("metric_test_001"),
        endTask: vi.fn(),
      };
    }

    it("should call startTask when processMessage begins", async () => {
      const mockRecorder = createMockRecorder();
      const orchWithMetrics = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        metricsRecorder: mockRecorder as any,
      });

      const promise = orchWithMetrics.handleMessage({
        channelType: "cli",
        chatId: "metrics1",
        userId: "user1",
        text: "Hello",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockRecorder.startTask).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "metrics1",
        taskType: "interactive",
      }));
    });

    it("should call endTask with correct agentPhase on completion", async () => {
      const mockRecorder = createMockRecorder();
      const orchWithMetrics = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        metricsRecorder: mockRecorder as any,
      });

      const promise = orchWithMetrics.handleMessage({
        channelType: "cli",
        chatId: "metrics2",
        userId: "user1",
        text: "Hello",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockRecorder.endTask).toHaveBeenCalledWith(
        "metric_test_001",
        expect.objectContaining({
          hitMaxIterations: false,
        }),
      );
    });

    it("should not throw when metricsRecorder is not provided", async () => {
      // orch created without metricsRecorder in beforeEach
      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "no-metrics",
        userId: "user1",
        text: "Hello",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBeUndefined();
    });

    it("should call endTask in finally block on unexpected error", async () => {
      const mockRecorder = createMockRecorder();
      const badProvider = {
        name: "bad",
        chat: vi.fn().mockRejectedValue(new Error("API down")),
      };

      const orchWithMetrics = new Orchestrator({
        providerManager: { getProvider: () => badProvider, getActiveInfo: () => ({ providerName: "bad", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        metricsRecorder: mockRecorder as any,
      });

      const promise = orchWithMetrics.handleMessage({
        channelType: "cli",
        chatId: "metrics-error",
        userId: "user1",
        text: "Hello",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      // The error should be caught by the session lock error handler
      await promise;

      // The finally block should ensure endTask is called (idempotent)
      expect(mockRecorder.startTask).toHaveBeenCalled();
      expect(mockRecorder.endTask).toHaveBeenCalled();
    });
  });
});
