import { describe, it, expect, vi } from "vitest";
import {
  handleBgReflectionDone,
  handleBgReflectionReplan,
  handleBgReflectionContinue,
  handleInteractiveReflectionReplan,
  handleInteractiveReflectionContinue,
  type BgReflectionContext,
  type InteractiveReflectionContext,
} from "./orchestrator-reflection-handler.js";
import { createInitialState, AgentPhase, transitionPhase } from "./agent-state.js";

// ─── State helpers ──────────────────────────────────────────────────────────────

function makeReflectingState() {
  const initial = createInitialState("test prompt");
  const executing = transitionPhase(initial, AgentPhase.EXECUTING);
  return transitionPhase(executing, AgentPhase.REFLECTING);
}

// ─── Mock factories ─────────────────────────────────────────────────────────────

function buildMockExecutionJournal() {
  return {
    beginReplan: vi.fn(),
    recordVerifierResult: vi.fn(),
    recordPhaseOutcome: vi.fn(),
    getState: vi.fn().mockReturnValue({ touchedFiles: [] }),
    getLearnedInsights: vi.fn().mockReturnValue([]),
  };
}

function buildMockSelfVerification() {
  return {
    getState: vi.fn().mockReturnValue({
      touchedFiles: [],
      hasCompilableChanges: false,
      lastVerificationAt: null,
    }),
    needsVerification: vi.fn().mockReturnValue(false),
    getPrompt: vi.fn().mockReturnValue(""),
  };
}

function buildMockSession() {
  return {
    messages: [] as Array<{ role: string; content: string }>,
  };
}

function buildMockBgCtx(overrides: Partial<BgReflectionContext> = {}): BgReflectionContext {
  const session = buildMockSession();
  return {
    chatId: "chat-1",
    identityKey: "key-1",
    prompt: "test prompt",
    responseText: "I need to replan.",
    responseUsage: undefined,
    toolCallCount: 0,
    executionStrategy: {
      task: { category: "general", complexity: "simple", requiresTools: false },
      reviewer: { providerName: "openai", modelId: "gpt-4" },
      synthesizer: { providerName: "openai", modelId: "gpt-4" },
      worker: { providerName: "openai", modelId: "gpt-4" },
    } as unknown as BgReflectionContext["executionStrategy"],
    executionJournal: buildMockExecutionJournal() as unknown as BgReflectionContext["executionJournal"],
    selfVerification: buildMockSelfVerification() as unknown as BgReflectionContext["selfVerification"],
    stradaConformance: {
      getPrompt: vi.fn().mockReturnValue(""),
    } as unknown as BgReflectionContext["stradaConformance"],
    taskStartedAtMs: Date.now(),
    currentToolNames: [],
    currentAssignment: {
      providerName: "openai",
      modelId: "gpt-4",
    } as unknown as BgReflectionContext["currentAssignment"],
    interventionDeps: {
      stripInternalDecisionMarkers: vi.fn((text: string | null | undefined) => text ?? ""),
    } as unknown as BgReflectionContext["interventionDeps"],
    session: session as unknown as BgReflectionContext["session"],
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn().mockReturnValue(undefined),
    usageHandler: undefined,
    // BgReflectionContext-specific
    progressAssessmentEnabled: false,
    controlLoopTracker: {
      getConsecutiveTextOnlyGates: vi.fn().mockReturnValue(0),
      recordGate: vi.fn().mockReturnValue(null),
      markRecoveryAttempt: vi.fn().mockReturnValue(1),
      hardCapReplan: 5,
      hardCapBlock: 8,
    } as unknown as BgReflectionContext["controlLoopTracker"],
    workerCollector: undefined,
    progressTitle: "Test task",
    progressLanguage: "en" as BgReflectionContext["progressLanguage"],
    iteration: 1,
    workspaceLease: undefined,
    systemPrompt: "You are a helpful assistant.",
    emitProgress: vi.fn(),
    buildStructuredProgressSignal: vi.fn().mockReturnValue({ kind: "replanning", message: "msg" }),
    getClarificationContext: vi.fn().mockReturnValue({}),
    formatBoundaryVisibleText: vi.fn().mockReturnValue(undefined),
    appendVisibleAssistantMessage: vi.fn(),
    synthesizeUserFacingResponse: vi.fn().mockResolvedValue("done"),
    persistSessionToMemory: vi.fn().mockResolvedValue(undefined),
    getVisibleTranscript: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as BgReflectionContext;
}

function buildMockInteractiveCtx(
  overrides: Partial<InteractiveReflectionContext> = {},
): InteractiveReflectionContext {
  const session = buildMockSession();
  return {
    chatId: "chat-2",
    identityKey: "key-2",
    prompt: "interactive prompt",
    responseText: "I need to replan.",
    responseUsage: undefined,
    toolCallCount: 0,
    executionStrategy: {
      task: { category: "general", complexity: "simple", requiresTools: false },
      reviewer: { providerName: "openai", modelId: "gpt-4" },
      synthesizer: { providerName: "openai", modelId: "gpt-4" },
      worker: { providerName: "openai", modelId: "gpt-4" },
    } as unknown as InteractiveReflectionContext["executionStrategy"],
    executionJournal: buildMockExecutionJournal() as unknown as InteractiveReflectionContext["executionJournal"],
    selfVerification: buildMockSelfVerification() as unknown as InteractiveReflectionContext["selfVerification"],
    stradaConformance: {
      getPrompt: vi.fn().mockReturnValue(""),
    } as unknown as InteractiveReflectionContext["stradaConformance"],
    taskStartedAtMs: Date.now(),
    currentToolNames: [],
    currentAssignment: {
      providerName: "openai",
      modelId: "gpt-4",
    } as unknown as InteractiveReflectionContext["currentAssignment"],
    interventionDeps: {
      stripInternalDecisionMarkers: vi.fn((text: string | null | undefined) => text ?? ""),
    } as unknown as InteractiveReflectionContext["interventionDeps"],
    session: session as unknown as InteractiveReflectionContext["session"],
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn().mockReturnValue(undefined),
    usageHandler: undefined,
    systemPrompt: "You are a helpful assistant.",
    ...overrides,
  } as unknown as InteractiveReflectionContext;
}

function buildMockProviderResponse(overrides: { toolCalls?: unknown[]; stopReason?: string; text?: string } = {}) {
  return {
    text: overrides.text ?? "",
    toolCalls: overrides.toolCalls ?? [],
    stopReason: overrides.stopReason ?? "end_turn",
    usage: undefined,
  } as unknown as import("./providers/provider.interface.js").ProviderResponse;
}

// ─── handleBgReflectionReplan ────────────────────────────────────────────────────

describe("handleBgReflectionReplan", () => {
  it("returns { flow: 'continue' } with REPLANNING state", () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx();

    const result = handleBgReflectionReplan(state, ctx);

    expect(result.flow).toBe("continue");
    expect(result).toHaveProperty("newState");
    if (result.flow === "continue") {
      expect(result.newState.phase).toBe(AgentPhase.REPLANNING);
    }
  });

  it("pushes assistant message and 'Please create a new plan.' to session", () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({ responseText: "The current approach is broken." });

    handleBgReflectionReplan(state, ctx);

    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toContainEqual({ role: "assistant", content: "The current approach is broken." });
    expect(messages).toContainEqual({ role: "user", content: "Please create a new plan." });
  });

  it("does not push assistant message when responseText is undefined", () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({ responseText: undefined });

    handleBgReflectionReplan(state, ctx);

    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(0);
    expect(messages).toContainEqual({ role: "user", content: "Please create a new plan." });
  });

  it("calls recordPhaseOutcome with status 'replanned'", () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx();

    handleBgReflectionReplan(state, ctx);

    expect(ctx.recordPhaseOutcome).toHaveBeenCalledOnce();
    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "replanned", phase: "reflecting" }),
    );
  });

  it("calls emitProgress with replanning kind", () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx();

    handleBgReflectionReplan(state, ctx);

    expect(ctx.emitProgress).toHaveBeenCalledOnce();
    expect(ctx.buildStructuredProgressSignal).toHaveBeenCalledWith(
      ctx.prompt,
      ctx.progressTitle,
      expect.objectContaining({ kind: "replanning" }),
      ctx.progressLanguage,
    );
  });
});

describe("handleBgReflectionDone", () => {
  it("passes daemonMode=true into background loop recovery", async () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({ responseText: "Still internal." });
    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "continue",
      gate: "Continue internally.",
    } as any);
    const recoverySpy = vi.spyOn(originalModule, "handleBackgroundLoopRecovery").mockResolvedValueOnce({
      action: "blocked",
      message: "Stopped.",
    } as any);

    await handleBgReflectionDone(state, ctx);

    expect(recoverySpy).toHaveBeenCalledWith(
      expect.objectContaining({ daemonMode: true }),
      expect.anything(),
    );

    vi.restoreAllMocks();
  });
});

// ─── handleBgReflectionContinue ──────────────────────────────────────────────────

describe("handleBgReflectionContinue", () => {
  it("returns { flow: 'continue' } with EXECUTING state (skipLastReflection)", async () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({ responseText: "Looks good, keep going." });

    const result = await handleBgReflectionContinue(state, ctx, 1);

    expect(result.flow).toBe("continue");
    if (result.flow === "continue") {
      expect(result.newState.phase).toBe(AgentPhase.EXECUTING);
      // skipLastReflection: lastReflection should NOT be updated to responseText
      expect(result.newState.lastReflection).toBe(state.lastReflection);
    }
  });

  it("pushes assistant message and 'Please continue.' when no tool calls", async () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({
      responseText: "Continuing the analysis.",
      interventionDeps: {
        stripInternalDecisionMarkers: vi.fn().mockReturnValue(""),
      } as unknown as BgReflectionContext["interventionDeps"],
    });

    await handleBgReflectionContinue(state, ctx, 0);

    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toContainEqual({ role: "assistant", content: "Continuing the analysis." });
    expect(messages).toContainEqual({ role: "user", content: "Please continue." });
  });

  it("does not push any messages when there are tool calls", async () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({ responseText: "Using a tool." });

    await handleBgReflectionContinue(state, ctx, 2);

    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toHaveLength(0);
  });

  it("does not push assistant message when responseText is undefined and no tool calls", async () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({ responseText: undefined });

    await handleBgReflectionContinue(state, ctx, 0);

    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(0);
    expect(messages).toContainEqual({ role: "user", content: "Please continue." });
  });

  it("finishes when a text-only continue draft is already finalizable", async () => {
    const state = makeReflectingState();
    const ctx = buildMockBgCtx({
      responseText: "Active project scope is /repo.",
      synthesizeUserFacingResponse: vi.fn().mockResolvedValue("Active project scope is /repo."),
    });
    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "none",
    } as any);
    vi.spyOn(originalModule, "resolveVerifierIntervention").mockResolvedValueOnce({
      kind: "approve",
      result: { summary: "Approved." },
    } as any);
    const result = await handleBgReflectionContinue(state, ctx, 0);

    expect(result.flow).toBe("done");
    if (result.flow === "done") {
      expect(result.visibleText).toBe("Active project scope is /repo.");
    }
    expect(ctx.persistSessionToMemory).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });
});

// ─── handleInteractiveReflectionReplan ────────────────────────────────────────────

describe("handleInteractiveReflectionReplan", () => {
  it("returns { flow: 'continue' } with state transitioned by handleReplanDecision", () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx();

    const result = handleInteractiveReflectionReplan(state, ctx);

    expect(result.flow).toBe("continue");
    if (result.flow === "continue") {
      // autoTransition: false — state stays in REFLECTING (not REPLANNING yet)
      expect(result.newState.phase).toBe(AgentPhase.REFLECTING);
      // But failedApproaches should be incremented (handleReplanDecision archives the approach)
      expect(result.newState.failedApproaches.length).toBeGreaterThan(
        state.failedApproaches.length,
      );
    }
  });

  it("does NOT push any session messages", () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx();

    handleInteractiveReflectionReplan(state, ctx);

    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toHaveLength(0);
  });

  it("does NOT call recordPhaseOutcome", () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx();

    handleInteractiveReflectionReplan(state, ctx);

    expect(ctx.recordPhaseOutcome).not.toHaveBeenCalled();
  });
});

// ─── handleInteractiveReflectionContinue ──────────────────────────────────────────

describe("handleInteractiveReflectionContinue", () => {
  it("returns { flow: 'continue' } when there are tool calls — no messages pushed", async () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx({ responseText: "Calling a tool." });
    const response = buildMockProviderResponse({ toolCalls: [{ name: "some_tool", input: {} }] });

    const result = await handleInteractiveReflectionContinue(state, ctx, response);

    expect(result.flow).toBe("continue");
    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toHaveLength(0);
  });

  it("pushes 'Please continue.' when no tool calls and no terminal failure", async () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx({ responseText: "Let me keep going." });
    // stopReason=end_turn with text that is NOT a terminal failure report
    const response = buildMockProviderResponse({
      toolCalls: [],
      stopReason: "end_turn",
      text: "Let me keep going.",
    });

    const result = await handleInteractiveReflectionContinue(state, ctx, response);

    expect(result.flow).toBe("continue");
    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toContainEqual({ role: "assistant", content: "Let me keep going." });
    expect(messages).toContainEqual({ role: "user", content: "Please continue." });
  });

  it("routes text-only reflection continue through loop recovery when tracker is present", async () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx({
      responseText: "Let me keep going.",
      progressAssessmentEnabled: false,
      controlLoopTracker: {
        getConsecutiveTextOnlyGates: vi.fn().mockReturnValue(1),
        recordGate: vi.fn().mockReturnValue(null),
        markRecoveryAttempt: vi.fn().mockReturnValue(1),
        hardCapReplan: 5,
        hardCapBlock: 8,
      } as unknown as InteractiveReflectionContext["controlLoopTracker"],
    });
    const response = buildMockProviderResponse({
      toolCalls: [],
      stopReason: "end_turn",
      text: "Let me keep going.",
    });
    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "handleBackgroundLoopRecovery").mockResolvedValueOnce({
      action: "replan",
      gate: "[LOOP RECOVERY] Use tools now.",
      summary: "Reflection continue loop detected.",
    } as any);

    const result = await handleInteractiveReflectionContinue(state, ctx, response);

    expect(result.flow).toBe("continue");
    if (result.flow === "continue") {
      expect(result.newState.phase).toBe(AgentPhase.REPLANNING);
    }
    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toContainEqual({ role: "assistant", content: "Let me keep going." });
    expect(messages).toContainEqual({ role: "user", content: "[LOOP RECOVERY] Use tools now." });

    vi.restoreAllMocks();
  });

  it("does not push assistant message when responseText is undefined and no tool calls", async () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx({ responseText: undefined });
    const response = buildMockProviderResponse({ toolCalls: [], stopReason: "end_turn", text: "" });

    await handleInteractiveReflectionContinue(state, ctx, response);

    const messages = (ctx.session as unknown as { messages: Array<{ role: string; content: string }> }).messages;
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(0);
    expect(messages).toContainEqual({ role: "user", content: "Please continue." });
  });

  it("returns EXECUTING state with skipLastReflection applied", async () => {
    const state = makeReflectingState();
    const ctx = buildMockInteractiveCtx({ responseText: "Some reflection text." });
    const response = buildMockProviderResponse({ toolCalls: [], stopReason: "end_turn", text: "Some reflection text." });

    const result = await handleInteractiveReflectionContinue(state, ctx, response);

    expect(result.flow).toBe("continue");
    if (result.flow === "continue") {
      expect(result.newState.phase).toBe(AgentPhase.EXECUTING);
      // skipLastReflection: lastReflection should NOT be overwritten
      expect(result.newState.lastReflection).toBe(state.lastReflection);
    }
  });
});
