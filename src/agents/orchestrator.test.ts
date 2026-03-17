import { Orchestrator } from "./orchestrator.js";
import Database from "better-sqlite3";
import type { ProviderResponse } from "./providers/provider.interface.js";
import type { IEventEmitter, LearningEventMap, ToolResultEvent } from "../core/event-bus.js";
import { ShowPlanTool } from "./tools/show-plan.js";
import { AskUserTool } from "./tools/ask-user.js";
import { DMPolicy } from "../security/dm-policy.js";
import { UserProfileStore } from "../memory/unified/user-profile-store.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildDepsContext: () => "",
  buildCapabilityManifest: () => "\n## Agent Capability Manifest\nGoal Decomposition\nLearning Pipeline\nIntrospection\n",
}));

function createMockProvider() {
  return {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
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

function getToolResultBlock(callArgs: any[] | undefined): any {
  const messages = (callArgs?.[1] as any[]) ?? [];
  const toolResultMsg = messages.find((m: any) =>
    m.role === "user" && Array.isArray(m.content)
  );
  return toolResultMsg?.content?.find((c: any) => c.type === "tool_result");
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

  it("captures an interactive user's name and injects it into later prompts", async () => {
    const db = new Database(":memory:");
    const userProfileStore = new UserProfileStore(db);
    const profileOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [readTool, writeTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
      userProfileStore,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "Nice to meet you, Alice.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: "Your name is Alice.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      });

    const firstMessage = profileOrch.handleMessage({
      channelType: "cli",
      chatId: "chat-profile",
      userId: "user1",
      text: "My name is Alice",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await firstMessage;

    expect(userProfileStore.getProfile("user1")?.displayName).toBe("Alice");

    const secondMessage = profileOrch.handleMessage({
      channelType: "cli",
      chatId: "chat-profile",
      userId: "user1",
      text: "What is my name?",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await secondMessage;

    expect(mockProvider.chat.mock.calls[1]?.[0]).toContain("Name: Alice");
    db.close();
  });

  it("persists assistant identity and response preferences from natural language instructions", async () => {
    const db = new Database(":memory:");
    const userProfileStore = new UserProfileStore(db);
    const profileOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [readTool, writeTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
      userProfileStore,
    });

    mockProvider.chat.mockResolvedValueOnce({
      text: "Preference update acknowledged.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    const promise = profileOrch.handleMessage({
      channelType: "cli",
      chatId: "chat-preferences",
      userId: "user1",
      text: "Adın Atlas olsun. Bundan sonra şu formatta cevap ver: önce kısa başlık, sonra 3 madde. Ultrathink modunu aç.",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const profile = userProfileStore.getProfile("user1");
    expect(profile?.preferences.assistantName).toBe("Atlas");
    expect(profile?.preferences.ultrathinkMode).toBe(true);
    expect(String(profile?.preferences.responseFormatInstruction ?? "")).toContain("önce kısa başlık");

    const firstPrompt = mockProvider.chat.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toContain('Assistant Identity: When referring to yourself, use the name "Atlas".');
    expect(firstPrompt).toContain("Response Format Instruction: önce kısa başlık, sonra 3 madde");
    expect(firstPrompt).toContain("Reasoning Mode: Use extra-careful, multi-step internal reasoning before answering.");
    db.close();
  });

  it("reuses a stable user identity for background tasks even when the chat session changes", async () => {
    const db = new Database(":memory:");
    const userProfileStore = new UserProfileStore(db);
    userProfileStore.upsertProfile("stable-web-user", { displayName: "Alice" });

    const profileOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [readTool, writeTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
      userProfileStore,
    });

    await profileOrch.runBackgroundTask("What is my name?", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      chatId: "new-web-chat",
      channelType: "web",
      userId: "stable-web-user",
    });

    expect(mockProvider.chat).toHaveBeenCalled();
    expect(String(mockProvider.chat.mock.calls.at(-1)?.[0] ?? "")).toContain("Name: Alice");
    db.close();
  });

  it("does not mistake response-format instructions for the user's display name", async () => {
    const db = new Database(":memory:");
    const userProfileStore = new UserProfileStore(db);
    const profileOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [readTool, writeTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
      userProfileStore,
    });

    mockProvider.chat.mockResolvedValueOnce({
      text: "Preference update acknowledged.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    const promise = profileOrch.handleMessage({
      channelType: "cli",
      chatId: "chat-format-name-guard",
      userId: "user1",
      text: "Bundan sonra bana kısa ve madde madde cevap ver.",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const profile = userProfileStore.getProfile("user1");
    expect(profile?.displayName).toBeUndefined();
    expect(profile?.preferences.verbosity).toBe("brief");
    expect(profile?.preferences.responseFormat).toBe("bullet points");
    db.close();
  });

  it("enables autonomous mode from natural language and skips write confirmation in the same turn", async () => {
    const db = new Database(":memory:");
    const userProfileStore = new UserProfileStore(db);
    const dmPolicy = new DMPolicy(mockChannel as any);
    const profileOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [readTool, writeTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
      userProfileStore,
      dmPolicy,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "tc-write-auto", name: "file_write", input: { path: "output.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: "Autonomous write complete.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 20 },
      });

    const promise = profileOrch.handleMessage({
      channelType: "cli",
      chatId: "chat-auto-natural",
      userId: "user-42",
      text: "Bu görev için autonom çalış ve approval sormadan ilerle.",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const autonomousState = await userProfileStore.isAutonomousMode("user-42");
    expect(autonomousState.enabled).toBe(true);
    expect(dmPolicy.isAutonomousActive("chat-auto-natural", "user-42")).toBe(true);
    expect(mockChannel.requestConfirmation).not.toHaveBeenCalled();
    expect(writeTool.execute).toHaveBeenCalled();
    expect(mockProvider.chat.mock.calls[0]?.[0]).toContain("## AUTONOMOUS MODE ACTIVE");
    db.close();
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

  it("filters blocked tools from the model and returns a read-only stub for blocked calls", async () => {
    const readOnlyOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [readTool, writeTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: true,
      requireConfirmation: true,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "tc1", name: "file_write", input: { path: "output.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 30 },
      })
      .mockResolvedValueOnce({
        text: "Blocked.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 60 },
      });

    const promise = readOnlyOrch.handleMessage({
      channelType: "cli",
      chatId: "chat1",
      userId: "user1",
      text: "Try to write a file",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const firstCallArgs = mockProvider.chat.mock.calls[0]!;
    const firstPrompt = firstCallArgs[0] as string;
    const firstToolDefs = firstCallArgs[2] as Array<{ name: string }>;
    expect(firstPrompt).toContain("READ-ONLY MODE ACTIVE");
    expect(firstToolDefs.map((tool) => tool.name)).toEqual(["file_read"]);

    expect(writeTool.execute).not.toHaveBeenCalled();

    const secondCallArgs = mockProvider.chat.mock.calls[1]!;
    const messages = secondCallArgs[1] as any[];
    const toolResultMsg = messages.find((m: any) =>
      m.role === "user" && Array.isArray(m.content)
    );
    const toolResultBlock = toolResultMsg?.content?.find((c: any) =>
      c.type === "tool_result"
    );
    expect(toolResultBlock?.content).toContain("disabled in read-only mode");
    expect(toolResultBlock?.is_error).toBe(true);
  });

  it("self-reviews and auto-approves strong plans in autonomous mode", async () => {
    const dmPolicy = new DMPolicy(mockChannel as any);
    dmPolicy.initFromProfile("auto-plan", { autonomousMode: true });

    const autoPlanOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [new ShowPlanTool()],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      dmPolicy,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{
          id: "tc-plan",
          name: "show_plan",
          input: {
            summary: "Inspect the failing workflow and land the minimal verified fix",
            steps: [
              "Read the failing workflow output and inspect the related implementation files",
              "Apply the minimal code change needed to remove the regression",
              "Run the relevant verification command and confirm the fix holds",
            ],
            reasoning: "This keeps the change small and verified before completion.",
          },
        }],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: "Proceeding.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 20 },
      });

    const promise = autoPlanOrch.handleMessage({
      channelType: "cli",
      chatId: "auto-plan",
      userId: "user1",
      text: "Handle this task autonomously",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockChannel.requestConfirmation).not.toHaveBeenCalled();
    const toolResultBlock = getToolResultBlock(mockProvider.chat.mock.calls[1]);
    expect(toolResultBlock?.content).toContain("Autonomous plan review passed");
    expect(toolResultBlock?.content).toContain("Proceed without waiting for user approval");
    expect(toolResultBlock?.is_error).toBe(false);
  });

  it("rejects weak plans in autonomous mode and asks the agent to revise them", async () => {
    const dmPolicy = new DMPolicy(mockChannel as any);
    dmPolicy.initFromProfile("auto-plan-reject", { autonomousMode: true });

    const autoPlanOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [new ShowPlanTool()],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
      dmPolicy,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{
          id: "tc-plan-reject",
          name: "show_plan",
          input: {
            summary: "Do stuff",
            steps: ["TODO", "Wait for approval"],
          },
        }],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: "Reworking the plan.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 20 },
      });

    const promise = autoPlanOrch.handleMessage({
      channelType: "cli",
      chatId: "auto-plan-reject",
      userId: "user1",
      text: "Handle this task autonomously",
      timestamp: new Date(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockChannel.requestConfirmation).not.toHaveBeenCalled();
    const toolResultBlock = getToolResultBlock(mockProvider.chat.mock.calls[1]);
    expect(toolResultBlock?.content).toContain("Autonomous plan review rejected");
    expect(toolResultBlock?.content).toContain("Revise the plan with concrete, executable, non-interactive steps");
    expect(toolResultBlock?.is_error).toBe(false);
  });

  it("resolves confirmation-like ask_user calls during background execution without waiting", async () => {
    const backgroundOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [new AskUserTool()],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: false,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{
          id: "tc-ask-bg",
          name: "ask_user",
          input: {
            question: "Should I proceed with the verified implementation?",
            options: ["Proceed", "Cancel"],
            recommended: "Proceed",
            context: "The implementation is ready and the relevant checks passed.",
          },
        }],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 20 },
      });

    const abortController = new AbortController();
    await backgroundOrch.runBackgroundTask("Apply the verified fix", {
      chatId: "bg-ask-review",
      channelType: "cli",
      signal: abortController.signal,
      onProgress: vi.fn(),
    });

    expect(mockChannel.requestConfirmation).not.toHaveBeenCalled();
    const toolResultBlock = getToolResultBlock(mockProvider.chat.mock.calls[1]);
    expect(toolResultBlock?.content).toContain("Autonomous question review (background mode)");
    expect(toolResultBlock?.content).toContain("Selected \"Proceed\"");
    expect(toolResultBlock?.is_error).toBe(false);
  });

  it("auto-approves safe write operations during background execution without waiting", async () => {
    const shellTool = createMockTool("shell_exec", true);
    const backgroundOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [shellTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{
          id: "tc-shell-bg",
          name: "shell_exec",
          input: {
            command: "npm test",
          },
        }],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          decision: "approve",
          reason: "Running the test suite is directly aligned with the task and bounded.",
          taskAligned: true,
          bounded: true,
        }),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      })
      .mockResolvedValueOnce({
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 20 },
      });

    const abortController = new AbortController();
    await backgroundOrch.runBackgroundTask("Run the test suite", {
      chatId: "bg-safe-shell",
      channelType: "cli",
      signal: abortController.signal,
      onProgress: vi.fn(),
    });

    expect(mockChannel.requestConfirmation).not.toHaveBeenCalled();
    expect(mockProvider.chat.mock.calls[1]?.[0]).toContain("shell safety arbiter");
    expect(shellTool.execute).toHaveBeenCalledWith(
      { command: "npm test" },
      expect.objectContaining({ chatId: "bg-safe-shell" }),
    );
  });

  it("approves bounded verification shell chains via fallback review when the reviewer is inconclusive", async () => {
    const shellTool = createMockTool("shell_exec", true);
    const backgroundOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [shellTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{
          id: "tc-shell-fallback",
          name: "shell_exec",
          input: {
            command: "test -f Assets/paor-proof.txt && grep -qx 'paor ok' Assets/paor-proof.txt",
          },
        }],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: "I am not sure.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      })
      .mockResolvedValueOnce({
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 20 },
      });

    const abortController = new AbortController();
    await backgroundOrch.runBackgroundTask("Verify the proof file", {
      chatId: "bg-safe-shell-fallback",
      channelType: "cli",
      signal: abortController.signal,
      onProgress: vi.fn(),
    });

    expect(shellTool.execute).toHaveBeenCalledWith(
      { command: "test -f Assets/paor-proof.txt && grep -qx 'paor ok' Assets/paor-proof.txt" },
      expect.objectContaining({ chatId: "bg-safe-shell-fallback" }),
    );
  });

  it("rejects shell commands that the orchestrator review marks as unrelated", async () => {
    const shellTool = createMockTool("shell_exec", true);
    const backgroundOrch = new Orchestrator({
      providerManager: {
        getProvider: () => mockProvider,
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as any,
      tools: [shellTool],
      channel: mockChannel,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
    });

    mockProvider.chat
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{
          id: "tc-shell-bg-reject",
          name: "shell_exec",
          input: {
            command: "cat ~/.ssh/config",
          },
        }],
        stopReason: "tool_use",
        usage: { inputTokens: 20, outputTokens: 20 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          decision: "reject",
          reason: "The command is unrelated to the requested coding task and probes sensitive host data.",
          taskAligned: false,
          bounded: false,
        }),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 10 },
      })
      .mockResolvedValueOnce({
        text: "Adjusted.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 20 },
      });

    const abortController = new AbortController();
    await backgroundOrch.runBackgroundTask("Clean the workspace", {
      chatId: "bg-danger-shell",
      channelType: "cli",
      signal: abortController.signal,
      onProgress: vi.fn(),
    });

    expect(mockChannel.requestConfirmation).not.toHaveBeenCalled();
    expect(shellTool.execute).not.toHaveBeenCalled();
    const toolResultBlock = getToolResultBlock(mockProvider.chat.mock.calls[2]);
    expect(toolResultBlock?.content).toContain("Self-managed write review rejected (background mode)");
    expect(toolResultBlock?.content).toContain("unrelated to the requested coding task");
    expect(toolResultBlock?.is_error).toBe(true);
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

    it("treats strada_create_system as a write operation", async () => {
      const systemTool = createMockTool("strada_create_system", true);
      const orchWithSystemTool = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [systemTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: true,
        dmPolicyConfig: { defaultLevel: "always" as any },
      });

      const toolResponse: ProviderResponse = {
        text: "",
        toolCalls: [{ id: "tc1", name: "strada_create_system", input: { name: "TestSystem" } }],
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

    it("does not allow reflection to finish while failures remain unverified", async () => {
      const buildTool = createMockTool("dotnet_build");
      buildTool.execute = vi.fn()
        .mockResolvedValueOnce({
          content: "Build failed: error CS0103",
          isError: true,
        })
        .mockResolvedValueOnce({
          content: "Build succeeded",
          isError: false,
        });

      const orchWithBuild = new Orchestrator({
        providerManager: {
          getProvider: () => mockProvider,
          getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
          shutdown: vi.fn(),
        } as any,
        tools: [buildTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const chatSpy = vi.fn()
        .mockResolvedValueOnce({
          text: "Plan: 1. Reproduce 2. Fix 3. Verify",
          toolCalls: [{ id: "tc-build-1", name: "dotnet_build", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "Patch applied.\n**DONE**",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [{ id: "tc-build-2", name: "dotnet_build", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "Verified clean.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        });

      mockProvider.chat = chatSpy;

      const promise = orchWithBuild.handleMessage({
        channelType: "cli",
        chatId: "paor-done-gate",
        userId: "user1",
        text: "Fix the failing build",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(chatSpy).toHaveBeenCalledTimes(4);
      const gatedMessages = chatSpy.mock.calls[2]?.[1] as Array<{ role: string; content: unknown }>;
      const gateMessage = gatedMessages.find((message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("UNRESOLVED FAILURES"),
      );
      expect(gateMessage).toBeDefined();
      expect(mockChannel.sendMarkdown).toHaveBeenCalledWith("paor-done-gate", "Verified clean.");
    });

    it("allows terminal failure reports to reach the user when the task remains unresolved", async () => {
      const buildTool = createMockTool("dotnet_build");
      buildTool.execute = vi.fn().mockResolvedValue({
        content: "Build timed out after 2 minutes",
        isError: true,
      });

      const orchWithBuild = new Orchestrator({
        providerManager: {
          getProvider: () => mockProvider,
          getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
          shutdown: vi.fn(),
        } as any,
        tools: [buildTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const chatSpy = vi.fn()
        .mockResolvedValueOnce({
          text: "Attempting build",
          toolCalls: [{ id: "tc-build-1", name: "dotnet_build", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "**CONTINUE**",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "This error requires manual intervention because the build timed out repeatedly.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        });

      mockProvider.chat = chatSpy;

      const promise = orchWithBuild.handleMessage({
        channelType: "cli",
        chatId: "paor-terminal-failure",
        userId: "user1",
        text: "Build the project",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(chatSpy).toHaveBeenCalledTimes(3);
      expect(mockChannel.sendMarkdown).toHaveBeenCalledWith(
        "paor-terminal-failure",
        "This error requires manual intervention because the build timed out repeatedly.",
      );
    });

    it("surfaces terminal failure reports directly from reflection when no decision marker is present", async () => {
      const readFailureTool = createMockTool("file_read");
      readFailureTool.execute = vi.fn().mockResolvedValue({
        content: "File not found",
        isError: true,
      });

      const orchWithReadFailure = new Orchestrator({
        providerManager: {
          getProvider: () => mockProvider,
          getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
          shutdown: vi.fn(),
        } as any,
        tools: [readFailureTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const chatSpy = vi.fn()
        .mockResolvedValueOnce({
          text: "Let me read that file.",
          toolCalls: [{ id: "tc-read-1", name: "file_read", input: { path: "Assets/Scripts/Missing.cs" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "I couldn't find that file. Please check the path.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        });

      mockProvider.chat = chatSpy;

      const promise = orchWithReadFailure.handleMessage({
        channelType: "cli",
        chatId: "reflection-terminal-failure",
        userId: "user1",
        text: "Read Missing.cs",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(chatSpy).toHaveBeenCalledTimes(2);
      expect(mockChannel.sendMarkdown).toHaveBeenCalledWith(
        "reflection-terminal-failure",
        "I couldn't find that file. Please check the path.",
      );
    });

    it("keeps working when the reflection text still says the agent will analyze further", async () => {
      const buildTool = createMockTool("dotnet_build");
      buildTool.execute = vi.fn().mockResolvedValue({
        content: "Build failed with unrecoverable project corruption",
        isError: true,
      });

      const orchWithBuild = new Orchestrator({
        providerManager: {
          getProvider: () => mockProvider,
          getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
          shutdown: vi.fn(),
        } as any,
        tools: [buildTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const chatSpy = vi.fn()
        .mockResolvedValueOnce({
          text: "Attempting build",
          toolCalls: [{ id: "tc-build-ongoing-1", name: "dotnet_build", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "CONTINUE — the build failed, let me analyze the situation.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        })
        .mockResolvedValueOnce({
          text: "This error requires manual intervention. The project file is corrupted and needs to be restored from version control or recreated.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20 },
        });

      mockProvider.chat = chatSpy;

      const promise = orchWithBuild.handleMessage({
        channelType: "cli",
        chatId: "reflection-ongoing-analysis",
        userId: "user1",
        text: "Fix the corrupted project",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(chatSpy).toHaveBeenCalledTimes(3);
      expect(mockChannel.sendMarkdown).toHaveBeenCalledWith(
        "reflection-ongoing-analysis",
        "This error requires manual intervention. The project file is corrupted and needs to be restored from version control or recreated.",
      );
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
          agentPhase: "complete",
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
        capabilities: {
          maxTokens: 4096, streaming: false, structuredStreaming: false,
          toolCalling: true, vision: false, systemPrompt: true,
        },
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
      expect(mockRecorder.endTask).toHaveBeenCalledWith(
        "metric_test_001",
        expect.objectContaining({
          agentPhase: "failed",
          hitMaxIterations: false,
        }),
      );
    });
  });

  describe("Streaming timeout behavior", () => {
    const initialTimeoutEnv = process.env["LLM_STREAM_INITIAL_TIMEOUT_MS"];
    const stallTimeoutEnv = process.env["LLM_STREAM_STALL_TIMEOUT_MS"];

    afterEach(() => {
      if (initialTimeoutEnv === undefined) {
        delete process.env["LLM_STREAM_INITIAL_TIMEOUT_MS"];
      } else {
        process.env["LLM_STREAM_INITIAL_TIMEOUT_MS"] = initialTimeoutEnv;
      }
      if (stallTimeoutEnv === undefined) {
        delete process.env["LLM_STREAM_STALL_TIMEOUT_MS"];
      } else {
        process.env["LLM_STREAM_STALL_TIMEOUT_MS"] = stallTimeoutEnv;
      }
    });

    it("keeps silent streaming alive while progress continues", async () => {
      process.env["LLM_STREAM_INITIAL_TIMEOUT_MS"] = "50";
      process.env["LLM_STREAM_STALL_TIMEOUT_MS"] = "50";

      const streamedResponse: ProviderResponse = {
        text: "stream complete",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      const streamingProvider = {
        name: "streaming",
        capabilities: {
          maxTokens: 4096,
          streaming: true,
          structuredStreaming: false,
          toolCalling: true,
          vision: false,
          systemPrompt: true,
        },
        chat: vi.fn(),
        chatStream: vi.fn((_system: string, _messages: unknown[], _tools: unknown[], onChunk: (chunk: string) => void) =>
          new Promise<ProviderResponse>((resolve) => {
            setTimeout(() => onChunk("a"), 40);
            setTimeout(() => onChunk("b"), 80);
            setTimeout(() => resolve(streamedResponse), 120);
          })),
      };

      const promise = (orch as any).silentStream(
        "stream-chat",
        "system",
        { messages: [], lastActivity: new Date() },
        streamingProvider,
      );

      await vi.advanceTimersByTimeAsync(130);
      await expect(promise).resolves.toEqual(streamedResponse);
      expect(streamingProvider.chat).not.toHaveBeenCalled();
    });

    it("falls back when the stream never starts", async () => {
      process.env["LLM_STREAM_INITIAL_TIMEOUT_MS"] = "50";
      process.env["LLM_STREAM_STALL_TIMEOUT_MS"] = "50";

      const fallbackResponse: ProviderResponse = {
        text: "fallback complete",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      const streamingProvider = {
        name: "streaming",
        capabilities: {
          maxTokens: 4096,
          streaming: true,
          structuredStreaming: false,
          toolCalling: true,
          vision: false,
          systemPrompt: true,
        },
        chat: vi.fn().mockResolvedValue(fallbackResponse),
        chatStream: vi.fn(() => new Promise<ProviderResponse>(() => {})),
      };

      const promise = (orch as any).silentStream(
        "stream-chat",
        "system",
        { messages: [], lastActivity: new Date() },
        streamingProvider,
      );

      await vi.advanceTimersByTimeAsync(60);
      await expect(promise).resolves.toEqual(fallbackResponse);
      expect(streamingProvider.chat).toHaveBeenCalledTimes(1);
    });
  });

  describe("Memory Re-retrieval Integration", () => {
    function createToolResponse(text: string, toolName?: string): ProviderResponse {
      if (toolName) {
        return {
          text,
          toolCalls: [{ id: `tc-${Date.now()}`, name: toolName, input: { path: "test.cs" } }],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      }
      return {
        text,
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }

    it("re-retrieval triggers after N iterations in interactive loop", async () => {
      // Setup: Create orchestrator with memoryManager, ragPipeline, and reRetrieval config
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({
          kind: "ok",
          value: [{ entry: { content: "refreshed memory" }, score: 0.9 }],
        }),
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };
      const mockRag = {
        search: vi.fn().mockResolvedValue([]),
        formatContext: vi.fn(() => ""),
      };
      const reRetrievalConfig = {
        enabled: true,
        interval: 2, // trigger every 2 iterations
        topicShiftEnabled: false,
        topicShiftThreshold: 0.4,
        maxReRetrievals: 10,
        timeoutMs: 5000,
        memoryLimit: 3,
        ragTopK: 6,
      };

      // Provider gives 3 tool iterations then end_turn
      const chatSpy = vi.fn()
        .mockResolvedValueOnce(createToolResponse("Plan: read file", "file_read"))
        .mockResolvedValueOnce(createToolResponse("CONTINUE - next step", "file_read"))
        .mockResolvedValueOnce(createToolResponse("CONTINUE - another step", "file_read"))
        .mockResolvedValueOnce(createToolResponse("Done!", undefined));
      mockProvider.chat = chatSpy;

      const orchWithReRetrieval = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        ragPipeline: mockRag as any,
        reRetrievalConfig,
      });

      const promise = orchWithReRetrieval.handleMessage({
        channelType: "cli",
        chatId: "rr-test-1",
        userId: "user1",
        text: "Test re-retrieval",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // memoryManager.retrieve should have been called more than just the initial retrieval
      // Initial retrieval + at least one re-retrieval
      expect(mockMemMgr.retrieve.mock.calls.length).toBeGreaterThan(1);
    });

    it("re-retrieval triggers in background task loop", async () => {
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({
          kind: "ok",
          value: [{ entry: { content: "bg refreshed memory" }, score: 0.9 }],
        }),
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };
      const mockRag = {
        search: vi.fn().mockResolvedValue([]),
        formatContext: vi.fn(() => ""),
      };
      const reRetrievalConfig = {
        enabled: true,
        interval: 2,
        topicShiftEnabled: false,
        topicShiftThreshold: 0.4,
        maxReRetrievals: 10,
        timeoutMs: 5000,
        memoryLimit: 3,
        ragTopK: 6,
      };

      // Provider gives 3 tool iterations, then reflection (PAOR triggers after 3 steps),
      // then end_turn. The reflection response returns **DONE** to complete.
      const chatSpy = vi.fn()
        .mockResolvedValueOnce(createToolResponse("Step 1", "file_read"))
        .mockResolvedValueOnce(createToolResponse("Step 2", "file_read"))
        .mockResolvedValueOnce(createToolResponse("Step 3", "file_read"))
        .mockResolvedValueOnce(createToolResponse("All steps succeeded.\n**DONE**", undefined))
        .mockResolvedValueOnce(createToolResponse("Task complete", undefined));
      mockProvider.chat = chatSpy;

      const orchBg = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        ragPipeline: mockRag as any,
        reRetrievalConfig,
      });

      const abortController = new AbortController();
      const result = await orchBg.runBackgroundTask("Test background re-retrieval", {
        chatId: "rr-bg-test",
        signal: abortController.signal,
        onProgress: vi.fn(),
      });

      expect(result).toBeDefined();
      // Background should also call retrieve more than initial
      expect(mockMemMgr.retrieve.mock.calls.length).toBeGreaterThan(1);
    });

    it("re-retrieval failure does not break loop", async () => {
      const mockMemMgr = {
        retrieve: vi.fn()
          .mockResolvedValueOnce({ kind: "ok", value: [{ entry: { content: "initial memory" }, score: 0.9 }] })
          .mockRejectedValueOnce(new Error("DB crashed")), // re-retrieval fails
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };
      const reRetrievalConfig = {
        enabled: true,
        interval: 1, // trigger every iteration
        topicShiftEnabled: false,
        topicShiftThreshold: 0.4,
        maxReRetrievals: 10,
        timeoutMs: 5000,
        memoryLimit: 3,
        ragTopK: 6,
      };

      // Provider gives 1 tool iteration then end_turn
      const chatSpy = vi.fn()
        .mockResolvedValueOnce(createToolResponse("Plan", "file_read"))
        .mockResolvedValueOnce(createToolResponse("Done!", undefined));
      mockProvider.chat = chatSpy;

      const orchFail = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        reRetrievalConfig,
      });

      const promise = orchFail.handleMessage({
        channelType: "cli",
        chatId: "rr-fail-test",
        userId: "user1",
        text: "Test failure recovery",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      // Should not throw - re-retrieval failure is non-fatal
      await expect(promise).resolves.toBeUndefined();
    });

    it("instinct retrieval added to background task", async () => {
      const mockRetriever = {
        getInsightsForTask: vi.fn().mockResolvedValue({
          insights: ["bg insight"],
          matchedInstinctIds: ["inst-bg-1"],
        }),
      };
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({ kind: "ok", value: [] }),
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };

      const chatSpy = vi.fn().mockResolvedValueOnce(createToolResponse("Done", undefined));
      mockProvider.chat = chatSpy;

      const orchInstinct = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        instinctRetriever: mockRetriever as any,
      });

      const abortController = new AbortController();
      await orchInstinct.runBackgroundTask("Test bg instincts", {
        chatId: "rr-instinct-bg",
        signal: abortController.signal,
        onProgress: vi.fn(),
      });

      // instinctRetriever should have been called during background task
      expect(mockRetriever.getInsightsForTask).toHaveBeenCalled();
    });

    it("topic shift triggers early re-retrieval", async () => {
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({
          kind: "ok",
          value: [{ entry: { content: "topic memory" }, score: 0.9 }],
        }),
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };
      const mockEmbedding = {
        name: "mock",
        dimensions: 3,
        embed: vi.fn()
          .mockResolvedValueOnce({ embeddings: [[1, 0, 0]], usage: { totalTokens: 10 } }) // initial baseline
          .mockResolvedValueOnce({ embeddings: [[1, 0, 0]], usage: { totalTokens: 10 } }) // 1st re-retrieval check: same topic
          .mockResolvedValueOnce({ embeddings: [[0, 1, 0]], usage: { totalTokens: 10 } }), // 2nd: shifted topic
      };
      const reRetrievalConfig = {
        enabled: true,
        interval: 100, // very high - periodic should NOT trigger
        topicShiftEnabled: true,
        topicShiftThreshold: 0.4,
        maxReRetrievals: 10,
        timeoutMs: 5000,
        memoryLimit: 3,
        ragTopK: 6,
      };

      const chatSpy = vi.fn()
        .mockResolvedValueOnce(createToolResponse("Plan", "file_read"))
        .mockResolvedValueOnce(createToolResponse("Step 2", "file_read"))
        .mockResolvedValueOnce(createToolResponse("Done!", undefined));
      mockProvider.chat = chatSpy;

      const orchTopic = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        embeddingProvider: mockEmbedding as any,
        reRetrievalConfig,
      });

      const promise = orchTopic.handleMessage({
        channelType: "cli",
        chatId: "rr-topic-test",
        userId: "user1",
        text: "Test topic shift",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Embedding provider should have been called for topic shift detection
      expect(mockEmbedding.embed).toHaveBeenCalled();
    });

    it("content deduplication prevents duplicate injection", async () => {
      // Same memory returned on initial and re-retrieval - should only inject once
      const sameMemory = { entry: { content: "same content" }, score: 0.9 };
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({ kind: "ok", value: [sameMemory] }),
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };
      const reRetrievalConfig = {
        enabled: true,
        interval: 1,
        topicShiftEnabled: false,
        topicShiftThreshold: 0.4,
        maxReRetrievals: 10,
        timeoutMs: 5000,
        memoryLimit: 3,
        ragTopK: 6,
      };

      const capturedPrompts: string[] = [];
      const chatSpy = vi.fn().mockImplementation((systemPrompt: string) => {
        capturedPrompts.push(systemPrompt);
        if (capturedPrompts.length <= 2) {
          return Promise.resolve(createToolResponse("Step", "file_read"));
        }
        return Promise.resolve(createToolResponse("Done!", undefined));
      });
      mockProvider.chat = chatSpy;

      const orchDedup = new Orchestrator({
        providerManager: { getProvider: () => mockProvider, getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }), shutdown: vi.fn() } as any,
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        reRetrievalConfig,
      });

      const promise = orchDedup.handleMessage({
        channelType: "cli",
        chatId: "rr-dedup-test",
        userId: "user1",
        text: "Test dedup",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // After re-retrieval with same content, the system prompt should not contain
      // "same content" duplicated in the memory section
      const lastPrompt = capturedPrompts[capturedPrompts.length - 1] ?? "";
      const memoryOccurrences = (lastPrompt.match(/same content/g) || []).length;
      expect(memoryOccurrences).toBeLessThanOrEqual(1);
    });
  });

  describe("PAOR Loop End-to-End", () => {
    it("full PAOR cycle: plan -> tool call -> observe -> reflect -> done", async () => {
      // Phase 1: PLANNING - provider returns text with a plan + tool call (transitions to EXECUTING)
      const planResponse: ProviderResponse = {
        text: "Plan:\n1. Read the file\n2. Analyze content\n\n[GOAL_PLAN] Read and analyze",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "main.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 40 },
      };

      // Phase 2: EXECUTING - provider returns another tool call
      const execResponse: ProviderResponse = {
        text: "Reading next file...",
        toolCalls: [{ id: "tc2", name: "file_read", input: { path: "helper.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 80, outputTokens: 50 },
      };

      // Phase 3: After 3 tool calls total (REFLECT_INTERVAL=3), a third tool call triggers REFLECTING
      const execResponse2: ProviderResponse = {
        text: "One more read...",
        toolCalls: [{ id: "tc3", name: "file_read", input: { path: "utils.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 60 },
      };

      // Phase 4: REFLECTING - provider decides DONE
      const reflectDoneResponse: ProviderResponse = {
        text: "Analysis complete. All files reviewed successfully.\n\n**DONE**",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 120, outputTokens: 30 },
      };

      mockProvider.chat
        .mockResolvedValueOnce(planResponse)
        .mockResolvedValueOnce(execResponse)
        .mockResolvedValueOnce(execResponse2)
        .mockResolvedValueOnce(reflectDoneResponse);

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "paor-e2e-1",
        userId: "user1",
        text: "Analyze the project files",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // All 4 provider calls should have been made (plan + 2 exec + reflect)
      expect(mockProvider.chat).toHaveBeenCalledTimes(4);
      // Tool was executed 3 times
      expect(readTool.execute).toHaveBeenCalledTimes(3);
      // Final DONE response was sent to channel
      expect(mockChannel.sendMarkdown).toHaveBeenCalledWith(
        "paor-e2e-1",
        expect.stringContaining("DONE"),
      );
    });

    it("tool failure mid-loop recovery: error -> retry -> success -> done", async () => {
      const buildTool = createMockTool("dotnet_build");
      buildTool.execute = vi.fn().mockResolvedValue({ content: "Build succeeded", isError: false });
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
        requireConfirmation: true,
      });

      // Step 1: Provider requests a tool call
      const firstToolCall: ProviderResponse = {
        text: "Plan: Build the project",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "broken.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 30, outputTokens: 20 },
      };

      // Step 2: After error, reflection phase triggers. Provider issues recovery tool call.
      const recoveryToolCall: ProviderResponse = {
        text: "CONTINUE - let me try reading a different file",
        toolCalls: [{ id: "tc2", name: "file_read", input: { path: "fixed.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 60, outputTokens: 30 },
      };

      const verifyToolCall: ProviderResponse = {
        text: "Now verifying the recovered state",
        toolCalls: [{ id: "tc3", name: "dotnet_build", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 70, outputTokens: 20 },
      };

      // Step 4: Provider signals completion
      const doneResponse: ProviderResponse = {
        text: "Recovery successful. Task complete.\nDONE",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 80, outputTokens: 20 },
      };

      // First tool call fails, second succeeds
      readTool.execute
        .mockResolvedValueOnce({ content: "Error: file not found", isError: true })
        .mockResolvedValueOnce({ content: "file content here" });

      mockProvider.chat
        .mockResolvedValueOnce(firstToolCall)
        .mockResolvedValueOnce(recoveryToolCall)
        .mockResolvedValueOnce(verifyToolCall)
        .mockResolvedValueOnce(doneResponse);

      const promise = orchWithBuild.handleMessage({
        channelType: "cli",
        chatId: "paor-e2e-recovery",
        userId: "user1",
        text: "Read the project file",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockProvider.chat.mock.calls.length).toBeGreaterThanOrEqual(4);
      // Tool was called twice (first failed, second succeeded)
      expect(readTool.execute).toHaveBeenCalledTimes(2);
      expect(buildTool.execute).toHaveBeenCalledTimes(1);
      // Final response was sent
      expect(mockChannel.sendMarkdown).toHaveBeenCalledWith(
        "paor-e2e-recovery",
        expect.stringContaining("Recovery successful"),
      );
    });

    it("MAX_TOOL_ITERATIONS enforcement: stops after 50 iterations", async () => {
      // Provider always returns tool_use - never ends
      const infiniteToolResponse: ProviderResponse = {
        text: "Continuing...",
        toolCalls: [{ id: "tc-loop", name: "file_read", input: { path: "loop.cs" } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 10 },
      };

      mockProvider.chat.mockResolvedValue(infiniteToolResponse);

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "paor-e2e-maxiter",
        userId: "user1",
        text: "Do an infinite task",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Provider should have been called at most ~52 times (50 iterations + overhead for PAOR phases)
      expect(mockProvider.chat.mock.calls.length).toBeLessThanOrEqual(52);
      // Should have sent the max iterations message
      expect(mockChannel.sendText).toHaveBeenCalledWith(
        "paor-e2e-maxiter",
        expect.stringContaining("maximum number of steps"),
      );
    });

    it("streaming error handling: chatStream throws gracefully handled", async () => {
      const streamingProvider = {
        name: "mock-stream",
        capabilities: {
          maxTokens: 4096, streaming: true, structuredStreaming: false,
          toolCalling: true, vision: false, systemPrompt: true,
        },
        chat: vi.fn().mockResolvedValue({
          text: "Fallback",
          toolCalls: [],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 10 },
        }),
        chatStream: vi.fn().mockRejectedValue(new Error("Stream connection failed")),
      };

      const streamingChannel = {
        ...createMockChannel(),
        startStreamingMessage: vi.fn().mockResolvedValue("stream-id-1"),
        updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
        finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
      };

      const streamOrch = new Orchestrator({
        providerManager: {
          getProvider: () => streamingProvider,
          getActiveInfo: () => ({ providerName: "mock-stream", model: "default", isDefault: true }),
          shutdown: vi.fn(),
        } as any,
        tools: [readTool],
        channel: streamingChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        streamingEnabled: true,
      });

      const promise = streamOrch.handleMessage({
        channelType: "cli",
        chatId: "paor-e2e-stream-err",
        userId: "user1",
        text: "Test streaming",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Agent loop uses batch mode (chat) — no streaming to avoid showing intermediate iterations
      expect(streamingProvider.chat).toHaveBeenCalled();
      // Fallback text sent via sendMarkdown
      expect(streamingChannel.sendMarkdown).toHaveBeenCalledWith("paor-e2e-stream-err", "Fallback");
    });
  });
});
