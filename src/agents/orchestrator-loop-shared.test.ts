import { describe, it, expect, vi } from "vitest";
import { createInitialState, AgentPhase } from "./agent-state.js";
import {
  executeAndTrackTools,
  refreshMemoryIfNeeded,
  runConsensusIfAvailable,
  checkPendingBlocks,
} from "./orchestrator-loop-shared.js";

// ---------------------------------------------------------------------------
// executeAndTrackTools
// ---------------------------------------------------------------------------

describe("executeAndTrackTools", () => {
  const toolCall = { id: "tc-1", name: "read_file", input: { path: "a.ts" } };
  const toolResult = { tool_use_id: "tc-1", content: "file contents", isError: false };

  function makeTrackingParams() {
    return {
      taskPlanner: { trackToolCall: vi.fn(), recordError: vi.fn() },
      selfVerification: { track: vi.fn(), ingestWorkerResult: vi.fn() },
      stradaConformance: { trackToolCall: vi.fn() },
      errorRecovery: { analyze: vi.fn().mockReturnValue(null) },
      executionJournal: {
        recordToolBatch: vi.fn(),
        recordPlan: vi.fn(),
        buildPromptSection: vi.fn().mockReturnValue(""),
      },
      agentPhase: AgentPhase.EXECUTING,
      providerName: "test-provider",
      emitToolResult: vi.fn(),
    };
  }

  it("pushes assistant message, executes tools, and tracks results", async () => {
    const session = { messages: [] as unknown[] };
    const executeFn = vi.fn().mockResolvedValue([toolResult]);

    const result = await executeAndTrackTools({
      chatId: "c1",
      responseText: "Let me read the file.",
      toolCalls: [toolCall],
      session: session as any,
      executeToolCalls: executeFn,
      executeOptions: { mode: "interactive" },
      trackingParams: makeTrackingParams() as any,
    });

    // Assistant message was pushed
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      role: "assistant",
      content: "Let me read the file.",
      tool_calls: [toolCall],
    });

    // executeToolCalls was called
    expect(executeFn).toHaveBeenCalledWith("c1", [toolCall], { mode: "interactive" });

    // Returns tool results
    expect(result.toolResults).toEqual([toolResult]);
  });

  it("passes tracking params through to trackAndRecordToolResults", async () => {
    const tracking = makeTrackingParams();
    const executeFn = vi.fn().mockResolvedValue([toolResult]);

    await executeAndTrackTools({
      chatId: "c2",
      responseText: "text",
      toolCalls: [toolCall],
      session: { messages: [] as unknown[] } as any,
      executeToolCalls: executeFn,
      executeOptions: {},
      trackingParams: tracking as any,
    });

    // taskPlanner.trackToolCall should have been invoked by trackAndRecordToolResults
    expect(tracking.taskPlanner.trackToolCall).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// refreshMemoryIfNeeded
// ---------------------------------------------------------------------------

describe("refreshMemoryIfNeeded", () => {
  const baseState = createInitialState("test task");

  it("returns unchanged prompt/state when refresher is null", async () => {
    const result = await refreshMemoryIfNeeded({
      memoryRefresher: null,
      iteration: 1,
      queryContext: "hello",
      chatId: "c1",
      systemPrompt: "original prompt",
      agentState: baseState,
    });
    expect(result.systemPrompt).toBe("original prompt");
    expect(result.agentState).toBe(baseState);
  });

  it("returns unchanged prompt/state when shouldRefresh returns false", async () => {
    const refresher = {
      shouldRefresh: vi.fn().mockResolvedValue({ should: false, reason: "none" }),
      refresh: vi.fn(),
    };
    const result = await refreshMemoryIfNeeded({
      memoryRefresher: refresher as any,
      iteration: 1,
      queryContext: "hello",
      chatId: "c1",
      systemPrompt: "original prompt",
      agentState: baseState,
    });
    expect(result.systemPrompt).toBe("original prompt");
    expect(refresher.refresh).not.toHaveBeenCalled();
  });

  it("updates system prompt sections when refresh triggers", async () => {
    const refresher = {
      shouldRefresh: vi.fn().mockResolvedValue({ should: true, reason: "periodic" }),
      refresh: vi.fn().mockResolvedValue({
        triggered: true,
        reason: "periodic",
        newMemoryContext: "new memory",
        newRagContext: "new rag",
        durationMs: 10,
        retrievalNumber: 1,
      }),
    };
    // replaceSection uses <!-- tag:start --> / <!-- tag:end --> markers
    const prompt =
      "start\n<!-- re-retrieval:memory:start -->\nold memory\n<!-- re-retrieval:memory:end -->\n" +
      "<!-- re-retrieval:rag:start -->\nold rag\n<!-- re-retrieval:rag:end -->\nend";
    const result = await refreshMemoryIfNeeded({
      memoryRefresher: refresher as any,
      iteration: 3,
      queryContext: "context",
      chatId: "c1",
      systemPrompt: prompt,
      agentState: baseState,
    });
    expect(result.systemPrompt).toContain("new memory");
    expect(result.systemPrompt).toContain("new rag");
    expect(result.systemPrompt).not.toContain("old memory");
    expect(result.systemPrompt).not.toContain("old rag");
  });

  it("updates agentState insights when refresh provides them", async () => {
    const refresher = {
      shouldRefresh: vi.fn().mockResolvedValue({ should: true, reason: "periodic" }),
      refresh: vi.fn().mockResolvedValue({
        triggered: true,
        reason: "periodic",
        newInsights: ["insight-1"],
        durationMs: 5,
        retrievalNumber: 1,
      }),
    };
    const result = await refreshMemoryIfNeeded({
      memoryRefresher: refresher as any,
      iteration: 1,
      queryContext: "q",
      chatId: "c1",
      systemPrompt: "prompt",
      agentState: baseState,
    });
    expect(result.agentState.learnedInsights).toEqual(["insight-1"]);
  });

  it("calls onNewInstinctIds when refresh provides instinct IDs", async () => {
    const refresher = {
      shouldRefresh: vi.fn().mockResolvedValue({ should: true, reason: "periodic" }),
      refresh: vi.fn().mockResolvedValue({
        triggered: true,
        reason: "periodic",
        newInstinctIds: ["inst-1", "inst-2"],
        durationMs: 5,
        retrievalNumber: 1,
      }),
    };
    const callback = vi.fn();
    await refreshMemoryIfNeeded({
      memoryRefresher: refresher as any,
      iteration: 1,
      queryContext: "q",
      chatId: "c1",
      systemPrompt: "prompt",
      agentState: baseState,
      onNewInstinctIds: callback,
    });
    expect(callback).toHaveBeenCalledWith(["inst-1", "inst-2"]);
  });

  it("does not call onNewInstinctIds when callback is not provided", async () => {
    const refresher = {
      shouldRefresh: vi.fn().mockResolvedValue({ should: true, reason: "periodic" }),
      refresh: vi.fn().mockResolvedValue({
        triggered: true,
        reason: "periodic",
        newInstinctIds: ["inst-1"],
        durationMs: 5,
        retrievalNumber: 1,
      }),
    };
    // Should not throw
    const result = await refreshMemoryIfNeeded({
      memoryRefresher: refresher as any,
      iteration: 1,
      queryContext: "q",
      chatId: "c1",
      systemPrompt: "prompt",
      agentState: baseState,
    });
    expect(result.systemPrompt).toBe("prompt");
  });

  it("swallows errors from shouldRefresh", async () => {
    const refresher = {
      shouldRefresh: vi.fn().mockRejectedValue(new Error("network error")),
      refresh: vi.fn(),
    };
    const result = await refreshMemoryIfNeeded({
      memoryRefresher: refresher as any,
      iteration: 1,
      queryContext: "q",
      chatId: "c1",
      systemPrompt: "prompt",
      agentState: baseState,
    });
    expect(result.systemPrompt).toBe("prompt");
  });
});

// ---------------------------------------------------------------------------
// runConsensusIfAvailable
// ---------------------------------------------------------------------------

describe("runConsensusIfAvailable", () => {
  function makeCtx(overrides: Record<string, unknown> = {}) {
    return {
      consensusManager: {
        shouldConsult: vi.fn().mockReturnValue({ strategy: "skip" }),
        verify: vi.fn(),
      },
      confidenceEstimator: {
        estimate: vi.fn().mockReturnValue(0.9),
      },
      providerManager: { listAvailable: () => [1, 2] },
      taskClassifier: {
        classify: vi.fn().mockReturnValue({
          category: "code_generation",
          complexity: "moderate",
          criticality: "normal",
        }),
      },
      prompt: "test prompt",
      responseText: "result text",
      toolCalls: [{ id: "tc-1", name: "read_file", input: {} }],
      currentAssignment: { providerName: "p1", modelId: "m1" },
      currentProviderCapabilities: null,
      agentState: createInitialState("task"),
      executionStrategy: {
        executor: { providerName: "p1", modelId: "m1" },
        reviewer: { providerName: "p2", modelId: "m2" },
        usesMultipleProviders: true,
        task: {
          category: "code_generation",
          complexity: "moderate",
          criticality: "normal",
        },
      },
      identityKey: "ik-1",
      chatId: "c1",
      resolveConsensusReviewAssignment: vi.fn().mockReturnValue(null),
      recordExecutionTrace: vi.fn(),
      recordPhaseOutcome: vi.fn(),
      ...overrides,
    };
  }

  it("returns immediately when consensusManager is falsy", async () => {
    const ctx = makeCtx({ consensusManager: null });
    await runConsensusIfAvailable(ctx as any);
    expect(ctx.taskClassifier.classify).not.toHaveBeenCalled();
  });

  it("returns immediately when confidenceEstimator is falsy", async () => {
    const ctx = makeCtx({ confidenceEstimator: null });
    await runConsensusIfAvailable(ctx as any);
    expect((ctx as any).taskClassifier.classify).not.toHaveBeenCalled();
  });

  it("calls classify, estimate, and runConsensusVerification", async () => {
    const ctx = makeCtx({ toolCalls: [] });
    await runConsensusIfAvailable(ctx as any);
    expect(ctx.taskClassifier.classify).toHaveBeenCalledWith("test prompt");
    expect(ctx.confidenceEstimator.estimate).toHaveBeenCalled();
  });

  it("skips consensus for non-critical tool batches", async () => {
    const ctx = makeCtx();

    await runConsensusIfAvailable(ctx as any);

    expect(ctx.confidenceEstimator.estimate).not.toHaveBeenCalled();
  });

  it("swallows errors from consensus verification", async () => {
    const ctx = makeCtx({
      toolCalls: [],
      consensusManager: {
        shouldConsult: vi.fn().mockImplementation(() => { throw new Error("boom"); }),
      },
    });
    // Should not throw
    await runConsensusIfAvailable(ctx as any);
  });
});

// ---------------------------------------------------------------------------
// checkPendingBlocks
// ---------------------------------------------------------------------------

describe("checkPendingBlocks", () => {
  function makeDeps(overrides: Partial<Parameters<typeof checkPendingBlocks>[0]> = {}) {
    return {
      getPendingPlanReviewVisibleText: vi.fn().mockReturnValue(null),
      getPendingSelfManagedWriteRejectionVisibleText: vi.fn().mockReturnValue(null),
      chatId: "c1",
      session: { messages: [] },
      responseText: "some text",
      ...overrides,
    } as Parameters<typeof checkPendingBlocks>[0];
  }

  it("returns blocked:false when no pending blocks", () => {
    const result = checkPendingBlocks(makeDeps());
    expect(result.blocked).toBe(false);
  });

  it("returns blocked:true with plan review text when plan review is pending", () => {
    const result = checkPendingBlocks(makeDeps({
      getPendingPlanReviewVisibleText: vi.fn().mockReturnValue("Plan review pending"),
    }));
    expect(result).toEqual({ blocked: true, text: "Plan review pending" });
  });

  it("returns blocked:true with write rejection text when write rejection is pending", () => {
    const result = checkPendingBlocks(makeDeps({
      getPendingSelfManagedWriteRejectionVisibleText: vi.fn().mockReturnValue("Write rejected"),
    }));
    expect(result).toEqual({ blocked: true, text: "Write rejected" });
  });

  it("prioritizes plan review over write rejection", () => {
    const result = checkPendingBlocks(makeDeps({
      getPendingPlanReviewVisibleText: vi.fn().mockReturnValue("Plan text"),
      getPendingSelfManagedWriteRejectionVisibleText: vi.fn().mockReturnValue("Write text"),
    }));
    expect(result).toEqual({ blocked: true, text: "Plan text" });
  });

  it("passes chatId to getPendingPlanReviewVisibleText", () => {
    const fn = vi.fn().mockReturnValue(null);
    checkPendingBlocks(makeDeps({ getPendingPlanReviewVisibleText: fn, chatId: "test-chat" }));
    expect(fn).toHaveBeenCalledWith("test-chat");
  });

  it("passes session and responseText to getPendingSelfManagedWriteRejectionVisibleText", () => {
    const fn = vi.fn().mockReturnValue(null);
    const session = { messages: [{ role: "user", content: "hi" }] };
    checkPendingBlocks(makeDeps({
      getPendingSelfManagedWriteRejectionVisibleText: fn,
      session: session as any,
      responseText: "draft",
    }));
    expect(fn).toHaveBeenCalledWith(session, "draft");
  });
});
