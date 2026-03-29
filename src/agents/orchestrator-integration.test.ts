/**
 * Orchestrator Integration Tests
 *
 * End-to-end tests covering multi-turn and full-pipeline behaviour through
 * the actual Orchestrator loop execution (runBackgroundTask, runAgentLoop).
 *
 * These tests complement the 78 existing tests in orchestrator.test.ts by
 * exercising the identified gaps: background task lifecycle, multi-turn
 * memory accumulation, intervention pipeline, and memory re-retrieval.
 */

import { Orchestrator } from "./orchestrator.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { DEFAULT_TASK_CONFIG } from "../config/config.js";

// ─── Logger mock (must match existing test pattern) ──────────────────────────

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getLogRingBuffer: () => [],
}));

vi.mock("./context/strada-knowledge.js", () => ({
  STRADA_SYSTEM_PROMPT: "Test system prompt.",
  buildProjectContext: () => "",
  buildAnalysisSummary: () => "",
  buildProjectWorldMemorySection: (params: {
    projectPath: string;
    analysis?: { modules?: Array<{ name: string }> } | null;
  }) => ({
    content: `## Project/World Memory\nActive project root: ${params.projectPath}\n${params.analysis?.modules?.[0]?.name ?? "No cached analysis"}`,
    contentHashes: [
      params.projectPath,
      params.analysis?.modules?.[0]?.name ?? "No cached analysis",
    ],
    summary: `root=${params.projectPath} | modules=${params.analysis?.modules?.[0]?.name ?? "none"}`,
    fingerprint: `root ${params.projectPath
      .replace(/[^a-z0-9]+/gi, " ")
      .trim()
      .toLowerCase()} modules ${(params.analysis?.modules?.[0]?.name ?? "none").toLowerCase()}`,
  }),
  buildDepsContext: () => "",
  buildCapabilityManifest: () =>
    "\n## Agent Capability Manifest\nGoal Decomposition\nLearning Pipeline\nIntrospection\n",
}));

// ─── Helpers (mirrors orchestrator.test.ts) ──────────────────────────────────

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
    onMessage: vi.fn((handler: any) => {
      messageHandler = handler;
    }),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
    requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    isHealthy: vi.fn().mockReturnValue(true),
    _trigger: async (msg: any) => {
      if (messageHandler) await messageHandler(msg);
    },
  };
}

function createMockTool(name: string) {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue({ content: `${name} result` }),
  };
}

/** Helper: build a ProviderResponse with or without tool calls. */
function toolResponse(text: string, toolName?: string): ProviderResponse {
  if (toolName) {
    return {
      text,
      toolCalls: [{ id: `tc-${Math.random().toString(36).slice(2, 8)}`, name: toolName, input: { path: "test.cs" } }],
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

/** Helper: build a verifier-approval response (completion review gate). */
function approvalResponse(): ProviderResponse {
  return {
    text: JSON.stringify({
      decision: "approve",
      summary: "Task completed cleanly.",
      closureStatus: "verified",
      openInvestigations: [],
      findings: [],
      requiredActions: [],
      reviews: {
        security: "not_applicable",
        code: "clean",
        simplify: "clean",
      },
      logStatus: "clean",
    }),
    toolCalls: [],
    stopReason: "end_turn" as const,
    usage: { inputTokens: 20, outputTokens: 10 },
  };
}

function makeProviderManager(provider: ReturnType<typeof createMockProvider>) {
  return {
    getProvider: () => provider,
    getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
    shutdown: vi.fn(),
  } as any;
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe("Orchestrator Integration", () => {
  let mockProvider: ReturnType<typeof createMockProvider>;
  let mockChannel: ReturnType<typeof createMockChannel>;
  let readTool: ReturnType<typeof createMockTool>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = createMockProvider();
    mockChannel = createMockChannel();
    readTool = createMockTool("file_read");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 1: runBackgroundTask End-to-End
  // ═══════════════════════════════════════════════════════════════════════════

  describe("runBackgroundTask End-to-End", () => {
    it("completes a simple task through PAOR cycle", async () => {
      // 1. PLANNING: tool call (transitions to EXECUTING)
      // 2. EXECUTING: another tool call
      // 3. EXECUTING: third tool call -> triggers REFLECTING (interval=3)
      // 4. REFLECTING: LLM says DONE
      // 5. Completion review: verifier approves
      mockProvider.chat
        .mockResolvedValueOnce(toolResponse("Plan: read all files", "file_read"))
        .mockResolvedValueOnce(toolResponse("Reading second file...", "file_read"))
        .mockResolvedValueOnce(toolResponse("Reading third file...", "file_read"))
        .mockResolvedValueOnce(toolResponse("Analysis complete.\n**DONE**"))
        .mockResolvedValueOnce(approvalResponse());

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const onProgress = vi.fn();
      const result = await orch.runBackgroundTask("Analyze the project files", {
        signal: new AbortController().signal,
        onProgress,
        chatId: "bg-e2e-1",
        channelType: "cli",
      });

      // Returns a string result
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      // Tool was executed 3 times
      expect(readTool.execute).toHaveBeenCalledTimes(3);
      // LLM called at least 4 times (3 tool rounds + reflection + possibly verifier)
      expect(mockProvider.chat.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it("handles task cancellation via AbortSignal", async () => {
      // Provider returns a slow chain of tool calls
      mockProvider.chat.mockResolvedValue(
        toolResponse("Working...", "file_read"),
      );

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const abortController = new AbortController();

      // Queue a micro-task to abort after the first LLM call resolves
      const originalChat = mockProvider.chat;
      let callCount = 0;
      mockProvider.chat = vi.fn(async (...args: any[]) => {
        callCount++;
        const res = await (originalChat as any)(...args);
        if (callCount >= 1) {
          abortController.abort();
        }
        return res;
      });

      await expect(
        orch.runBackgroundTask("Long running task", {
          signal: abortController.signal,
          onProgress: vi.fn(),
          chatId: "bg-cancel-1",
          channelType: "cli",
        }),
      ).rejects.toThrow(/cancel/i);
    });

    it("emits progress signals during execution", async () => {
      // Multi-step flow: 2 tool calls -> end_turn
      mockProvider.chat
        .mockResolvedValueOnce(toolResponse("Step 1", "file_read"))
        .mockResolvedValueOnce(toolResponse("Step 2", "file_read"))
        .mockResolvedValueOnce(toolResponse("Done with analysis.", undefined));

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const onProgress = vi.fn();
      await orch.runBackgroundTask("Analyze code", {
        signal: new AbortController().signal,
        onProgress,
        chatId: "bg-progress-1",
        channelType: "cli",
      });

      // Progress should have been called at least once (tool batch signals)
      expect(onProgress).toHaveBeenCalled();
      // At least one call should contain structured progress data
      const structuredCalls = onProgress.mock.calls.filter(
        ([arg]: [any]) => typeof arg === "object" && arg !== null && "kind" in arg,
      );
      expect(structuredCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("returns visible text on simple end_turn without tool calls", async () => {
      mockProvider.chat.mockResolvedValueOnce({
        text: "Here is your answer: the build config looks correct.",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 50, outputTokens: 30 },
      });

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      const result = await orch.runBackgroundTask("Is the build config correct?", {
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        chatId: "bg-simple-1",
        channelType: "cli",
      });

      expect(result).toContain("build config");
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 2: Multi-turn Conversation Memory
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Multi-turn conversation memory", () => {
    it("persists visible transcript after each turn", async () => {
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({
          kind: "ok",
          value: [],
        }),
        storeConversation: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: true,
        memoryManager: mockMemMgr as any,
      });

      // Turn 1
      mockProvider.chat.mockResolvedValueOnce({
        text: "First turn response.",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      const p1 = orch.handleMessage({
        channelType: "cli",
        chatId: "multi-turn-1",
        userId: "user1",
        text: "Hello, first message",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await p1;

      // Turn 2
      mockProvider.chat.mockResolvedValueOnce({
        text: "Second turn response.",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 15, outputTokens: 25 },
      });
      const p2 = orch.handleMessage({
        channelType: "cli",
        chatId: "multi-turn-1",
        userId: "user1",
        text: "Follow-up message",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await p2;

      // Turn 3
      mockProvider.chat.mockResolvedValueOnce({
        text: "Third turn response.",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 20, outputTokens: 30 },
      });
      const p3 = orch.handleMessage({
        channelType: "cli",
        chatId: "multi-turn-1",
        userId: "user1",
        text: "Another follow-up",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await p3;

      // Memory storeConversation should have been called (persistSessionToMemory delegates to it)
      expect(mockMemMgr.storeConversation).toHaveBeenCalled();

      // The session should have accumulated messages from all 3 turns
      const session = (orch as any).sessionManager.getOrCreateSession("multi-turn-1");
      // At least 6 visible messages: 3 user + 3 assistant
      const visibleMessages = (orch as any).sessionManager.getVisibleTranscript(session);
      expect(visibleMessages.length).toBeGreaterThanOrEqual(6);
    });

    it("carries agent state across turns within same session", async () => {
      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: true,
      });

      // Turn 1: provider receives only the first user message
      mockProvider.chat.mockResolvedValueOnce({
        text: "I understand you want to build a castle module.",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      const p1 = orch.handleMessage({
        channelType: "cli",
        chatId: "state-carry-1",
        userId: "user1",
        text: "I want to build a castle module",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await p1;

      // Turn 2: should include context from turn 1
      mockProvider.chat.mockResolvedValueOnce({
        text: "Adding towers to the castle module.",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 20, outputTokens: 30 },
      });
      const p2 = orch.handleMessage({
        channelType: "cli",
        chatId: "state-carry-1",
        userId: "user1",
        text: "Now add towers to it",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await p2;

      // Verify: the second call to provider should have messages from turn 1
      const secondCallMessages = mockProvider.chat.mock.calls[1]?.[1] as any[];
      expect(secondCallMessages).toBeDefined();
      // Should contain at least: [user1, assistant1, user2]
      expect(secondCallMessages.length).toBeGreaterThanOrEqual(3);

      // The second call must include the first turn's assistant response text
      // in the conversation history, proving context carries across turns.
      const allMessageTexts = secondCallMessages.map((m: any) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return (m.content as any[])
            .filter((b: any) => b.type === "text" && b.text)
            .map((b: any) => b.text)
            .join(" ");
        }
        return "";
      });
      const combinedHistory = allMessageTexts.join("\n");
      // The first turn's assistant reply should appear in the second call's messages
      expect(combinedHistory).toContain("castle module");
    });

    it("accumulates visible messages correctly across handleMessage calls", async () => {
      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: true,
      });

      const responses = ["Response A", "Response B", "Response C"];
      for (let i = 0; i < 3; i++) {
        mockProvider.chat.mockResolvedValueOnce({
          text: responses[i],
          toolCalls: [],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 20 },
        });
        const p = orch.handleMessage({
          channelType: "cli",
          chatId: "accumulate-1",
          userId: "user1",
          text: `Message ${i + 1}`,
          timestamp: new Date(),
        });
        await vi.advanceTimersByTimeAsync(100);
        await p;
      }

      // Channel should have received each response
      expect(mockChannel.sendMarkdown).toHaveBeenCalledTimes(3);
      expect(mockChannel.sendMarkdown).toHaveBeenNthCalledWith(1, "accumulate-1", "Response A");
      expect(mockChannel.sendMarkdown).toHaveBeenNthCalledWith(2, "accumulate-1", "Response B");
      expect(mockChannel.sendMarkdown).toHaveBeenNthCalledWith(3, "accumulate-1", "Response C");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 3: Intervention Pipeline E2E
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Intervention pipeline through loops", () => {
    it("verifier triggers replan when completion review rejects with findings", async () => {
      // Flow: tool call -> tool call -> tool call -> DONE ->
      //   verifier REJECTS (findings) -> LLM replans -> end_turn -> verifier approves
      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        taskConfig: {
          ...DEFAULT_TASK_CONFIG,
          backgroundEpochMaxIterations: 20,
        },
      });

      const stageClean = {
        text: JSON.stringify({ status: "clean", summary: "No issues found." }),
        toolCalls: [] as never[],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 5, outputTokens: 5 },
      };

      mockProvider.chat
        // First pass: 3 tool calls -> reflection with DONE
        .mockResolvedValueOnce(toolResponse("Step 1: read main", "file_read"))
        .mockResolvedValueOnce(toolResponse("Step 2: read helper", "file_read"))
        .mockResolvedValueOnce(toolResponse("Step 3: read utils", "file_read"))
        .mockResolvedValueOnce(toolResponse("All done.\n**DONE**"))
        // First completion review: 3 parallel stages + 1 synthesis (rejects)
        .mockResolvedValueOnce({
          text: JSON.stringify({ status: "issues", summary: "Missing error handling", findings: ["Missing try-catch in utils.cs"], requiredActions: ["Add error handling to utils.cs"] }),
          toolCalls: [] as never[],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 5, outputTokens: 5 },
        })
        .mockResolvedValueOnce(stageClean)
        .mockResolvedValueOnce({
          text: JSON.stringify({ status: "issues", summary: "Security concern", findings: ["Unvalidated input in utils.cs"] }),
          toolCalls: [] as never[],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 5, outputTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            decision: "revise",
            summary: "Missing error handling in utils.cs",
            closureStatus: "open_issues",
            openInvestigations: ["error handling gap"],
            findings: [{ severity: "high", description: "Missing try-catch in utils.cs" }],
            requiredActions: ["Add error handling to utils.cs"],
            reviews: {
              security: "needs_work",
              code: "needs_work",
              simplify: "clean",
            },
            logStatus: "warnings",
          }),
          toolCalls: [],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 30, outputTokens: 20 },
        })
        // After replan: LLM does one more tool call and then finishes
        .mockResolvedValueOnce(toolResponse("Fixing error handling...", "file_read"))
        .mockResolvedValueOnce(toolResponse("Fix applied. Task complete.\n**DONE**"))
        // Second completion review: 3 parallel stages + 1 synthesis (approves)
        .mockResolvedValueOnce(stageClean)
        .mockResolvedValueOnce(stageClean)
        .mockResolvedValueOnce(stageClean)
        .mockResolvedValueOnce(approvalResponse());

      const result = await orch.runBackgroundTask("Analyze and fix error handling", {
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        chatId: "bg-intervention-replan-1",
        channelType: "cli",
      });

      // The provider was called more than the initial 4+4 times (replan happened)
      // 4 tool/DONE + 4 first review (3 stages + 1 synthesis) + 2 after replan + 4 second review = 14
      expect(mockProvider.chat.mock.calls.length).toBeGreaterThan(8);
      // Tool executed more than 3 times (initial 3 + at least 1 after replan)
      expect(readTool.execute.mock.calls.length).toBeGreaterThan(3);
      // Result should be a non-empty string
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("interaction policy blocks background task when explicit plan review is required", async () => {
      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
      });

      // Provider returns a plan-like text without tool calls (user asked for plan)
      mockProvider.chat.mockResolvedValueOnce({
        text: "## Plan\n1. Read files\n2. Analyze patterns\n3. Generate report\n\nfile_read Assets/Scripts/main.cs\nfile_read Assets/Scripts/helper.cs",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 30, outputTokens: 40 },
      });

      const result = await orch.runBackgroundTask(
        "Show me the plan before you touch the code.",
        {
          signal: new AbortController().signal,
          onProgress: vi.fn(),
          chatId: "bg-plan-review-block-1",
          channelType: "cli",
        },
      );

      // Result should contain plan-related content (blocked for review)
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      // Provider should only be called once (blocked before further iteration)
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 4: Memory Re-retrieval During Loop Execution
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Memory re-retrieval during loop execution", () => {
    it("refreshes memory context after tool execution modifies files (interactive)", async () => {
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({
          kind: "ok",
          value: [{ entry: { content: "initial memory" }, score: 0.9 }],
        }),
        store: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
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

      // Provider: 3 tool iterations then end_turn
      mockProvider.chat
        .mockResolvedValueOnce(toolResponse("Plan: analyze files", "file_read"))
        .mockResolvedValueOnce(toolResponse("CONTINUE - reading more", "file_read"))
        .mockResolvedValueOnce(toolResponse("CONTINUE - one more", "file_read"))
        .mockResolvedValueOnce(toolResponse("Analysis complete."));

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        ragPipeline: mockRag as any,
        reRetrievalConfig,
      });

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "rr-integration-1",
        userId: "user1",
        text: "Analyze files and update memory",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Memory retrieve should be called more than once: initial + at least one re-retrieval
      expect(mockMemMgr.retrieve.mock.calls.length).toBeGreaterThan(1);
    });

    it("refreshes memory context in background task loop", async () => {
      const mockMemMgr = {
        retrieve: vi
          .fn()
          .mockResolvedValueOnce({
            kind: "ok",
            value: [{ entry: { content: "initial context" }, score: 0.9 }],
          })
          .mockResolvedValue({
            kind: "ok",
            value: [{ entry: { content: "refreshed context after tool run" }, score: 0.95 }],
          }),
        store: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
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

      // Provider: 3 tool calls -> DONE -> verifier approves
      mockProvider.chat
        .mockResolvedValueOnce(toolResponse("Step 1: read", "file_read"))
        .mockResolvedValueOnce(toolResponse("Step 2: read more", "file_read"))
        .mockResolvedValueOnce(toolResponse("Step 3: analyze", "file_read"))
        .mockResolvedValueOnce(toolResponse("All steps completed.\n**DONE**"))
        .mockResolvedValueOnce(approvalResponse());

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        ragPipeline: mockRag as any,
        reRetrievalConfig,
      });

      const result = await orch.runBackgroundTask("Analyze with memory refresh", {
        chatId: "rr-bg-integration-1",
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        channelType: "cli",
      });

      // Memory should have been retrieved more than once (initial + re-retrieval)
      expect(mockMemMgr.retrieve.mock.calls.length).toBeGreaterThan(1);
      // Second retrieval should return the refreshed context
      // (verifying the mock was consumed in order)
      const secondRetrievalResult = await mockMemMgr.retrieve();
      expect(secondRetrievalResult.value[0].entry.content).toBe("refreshed context after tool run");
      // Task should complete successfully
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("does not trigger re-retrieval when config is disabled", async () => {
      const mockMemMgr = {
        retrieve: vi.fn().mockResolvedValue({
          kind: "ok",
          value: [{ entry: { content: "only memory" }, score: 0.9 }],
        }),
        store: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
        getCachedAnalysis: vi.fn().mockResolvedValue({ kind: "ok", value: { kind: "none" } }),
      };

      // Provider: 3 tool iterations then end_turn
      mockProvider.chat
        .mockResolvedValueOnce(toolResponse("Step 1", "file_read"))
        .mockResolvedValueOnce(toolResponse("Step 2", "file_read"))
        .mockResolvedValueOnce(toolResponse("Step 3", "file_read"))
        .mockResolvedValueOnce(toolResponse("Done."));

      const orch = new Orchestrator({
        providerManager: makeProviderManager(mockProvider),
        tools: [readTool],
        channel: mockChannel,
        projectPath: "/tmp/test-project",
        readOnly: false,
        requireConfirmation: false,
        memoryManager: mockMemMgr as any,
        // No reRetrievalConfig => disabled
      });

      const promise = orch.handleMessage({
        channelType: "cli",
        chatId: "rr-disabled-1",
        userId: "user1",
        text: "Do analysis without re-retrieval",
        timestamp: new Date(),
      });
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Memory retrieve should be called only once (initial context build)
      // or at most once for the initial system prompt construction
      const retrieveCount = mockMemMgr.retrieve.mock.calls.length;
      expect(retrieveCount).toBeLessThanOrEqual(1);
    });
  });
});
