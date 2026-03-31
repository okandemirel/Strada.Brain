/**
 * Basic tests for orchestrator-end-turn-handler.ts
 *
 * These tests verify the EndTurnLoopAction discriminated union and
 * the handler functions' core behavior using minimal stubs.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleBgEndTurn, handleInteractiveEndTurn } from "./orchestrator-end-turn-handler.js";
import type { BgEndTurnContext, InteractiveEndTurnContext } from "./orchestrator-end-turn-handler.js";
import { AgentPhase, createInitialState } from "./agent-state.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-end-turn-test.log"); } catch { /* already initialized */ }
});

// ─── Stub factories ────────────────────────────────────────────────────────────

function makeMinimalAssignment() {
  return {
    providerName: "test-provider",
    modelId: "test-model",
    role: "executor" as const,
  } as any;
}

function makeMinimalStrategy() {
  return {
    task: { type: "code_generation", criticality: "normal" },
    executor: makeMinimalAssignment(),
    reviewer: makeMinimalAssignment(),
    synthesizer: makeMinimalAssignment(),
    planReviewer: makeMinimalAssignment(),
  } as any;
}

function makeMinimalSession() {
  return {
    messages: [] as any[],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  } as any;
}

function makeMinimalSelfVerification() {
  return {
    getState: () => ({
      touchedFiles: new Set<string>(),
      lastBuildOk: true,
      lastVerificationAt: null,
    }),
  } as any;
}

function makeMinimalInterventionDeps() {
  return {
    getReviewerAssignment: vi.fn().mockReturnValue(makeMinimalAssignment()),
    classifyTask: vi.fn().mockReturnValue({ type: "code_generation", criticality: "normal" }),
    buildSupervisorRolePrompt: vi.fn().mockReturnValue(""),
    systemPrompt: "test system prompt",
    clarificationContext: { interactionConfig: {}, toolMetadataByName: {} },
    stripInternalDecisionMarkers: vi.fn((t: string) => t ?? ""),
    interactionPolicy: { requirePlanReview: vi.fn() },
    formatPlanReviewMessage: vi.fn((d: string) => `Plan: ${d}`),
    recordExecutionTrace: vi.fn(),
    recordAuxiliaryUsage: vi.fn(),
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn(),
    recordRuntimeArtifactEvaluation: vi.fn(),
    getTaskRunId: vi.fn(),
    synthesizeUserFacingResponse: vi.fn(async (p: any) => p.draft || ""),
    runCompletionReviewStages: vi.fn(async () => ({ stages: [], finalDecision: "approve" })),
    runVisibilityReview: vi.fn(async () => ({ decision: { decision: "allow", reason: "safe to surface" } })),
    executeToolCalls: vi.fn(async () => []),
    getLogRingBuffer: vi.fn(() => []),
    buildStructuredProgressSignal: vi.fn((_p, _t, s) => s),
  } as any;
}

// ─── BG End Turn Tests ─────────────────────────────────────────────────────────

describe("handleBgEndTurn", () => {
  it("returns done with clarification ask_user message", async () => {
    const agentState = createInitialState();
    const ctx: BgEndTurnContext = {
      chatId: "test-chat",
      identityKey: "test-user",
      prompt: "test prompt",
      responseText: "draft text",
      responseUsage: undefined,
      executionStrategy: makeMinimalStrategy(),
      executionJournal: {
        recordVerifierResult: vi.fn(),
      } as any,
      selfVerification: makeMinimalSelfVerification(),
      stradaConformance: {} as any,
      taskStartedAtMs: Date.now(),
      currentToolNames: [],
      currentAssignment: makeMinimalAssignment(),
      interventionDeps: {
        ...makeMinimalInterventionDeps(),
        // Override to return ask_user
      },
      session: makeMinimalSession(),
      usageHandler: undefined,
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      progressAssessmentEnabled: false,
      controlLoopTracker: { markVerificationClean: vi.fn(), markMeaningfulFileEvidence: vi.fn() } as any,
      workerCollector: undefined,
      progressTitle: "Test",
      progressLanguage: "en" as any,
      iteration: 0,
      workspaceLease: undefined,
      systemPrompt: "test",
      emitProgress: vi.fn(),
      buildStructuredProgressSignal: vi.fn((_p, _t, s) => s) as any,
      getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: {} }) as any,
      formatBoundaryVisibleText: vi.fn((b) => b.visibleText),
      appendVisibleAssistantMessage: vi.fn(),
      synthesizeUserFacingResponse: vi.fn(async (p) => p.draft),
      persistSessionToMemory: vi.fn(async () => {}),
      getVisibleTranscript: vi.fn(() => []),
    };

    // Mock the clarification pipeline to return ask_user
    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "ask_user",
      message: "What do you mean?",
    } as any);

    const result = await handleBgEndTurn(agentState, ctx);

    expect(result.flow).toBe("done");
    if (result.flow === "done") {
      expect(result.visibleText).toBe("What do you mean?");
      expect(result.status).toBe("blocked");
    }

    vi.restoreAllMocks();
  });

  it("passes daemonMode=true into background loop recovery", async () => {
    const agentState = createInitialState();
    const ctx: BgEndTurnContext = {
      chatId: "test-chat",
      identityKey: "test-user",
      prompt: "test prompt",
      responseText: "draft text",
      responseUsage: undefined,
      executionStrategy: makeMinimalStrategy(),
      executionJournal: { recordVerifierResult: vi.fn() } as any,
      selfVerification: makeMinimalSelfVerification(),
      stradaConformance: {} as any,
      taskStartedAtMs: Date.now(),
      currentToolNames: [],
      currentAssignment: makeMinimalAssignment(),
      interventionDeps: makeMinimalInterventionDeps(),
      session: makeMinimalSession(),
      usageHandler: undefined,
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      progressAssessmentEnabled: false,
      controlLoopTracker: { markVerificationClean: vi.fn(), markMeaningfulFileEvidence: vi.fn() } as any,
      workerCollector: undefined,
      progressTitle: "Test",
      progressLanguage: "en" as any,
      iteration: 0,
      workspaceLease: undefined,
      systemPrompt: "test",
      daemonMode: true,
      emitProgress: vi.fn(),
      buildStructuredProgressSignal: vi.fn((_p, _t, s) => s) as any,
      getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: {} }) as any,
      formatBoundaryVisibleText: vi.fn((b) => b.visibleText),
      appendVisibleAssistantMessage: vi.fn(),
      synthesizeUserFacingResponse: vi.fn(async (p) => p.draft),
      persistSessionToMemory: vi.fn(async () => {}),
      getVisibleTranscript: vi.fn(() => []),
    };

    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "continue",
      gate: "Keep going.",
    } as any);
    const recoverySpy = vi.spyOn(originalModule, "handleBackgroundLoopRecovery").mockResolvedValueOnce({
      action: "blocked",
      message: "Stopped.",
    } as any);

    await handleBgEndTurn(agentState, ctx);

    expect(recoverySpy).toHaveBeenCalledWith(
      expect.objectContaining({ daemonMode: true }),
      expect.anything(),
    );

    vi.restoreAllMocks();
  });

  it("routes final visibility rejection through background loop recovery", async () => {
    const agentState = createInitialState();
    const ctx: BgEndTurnContext = {
      chatId: "test-chat",
      identityKey: "test-user",
      prompt: "test prompt",
      responseText: "draft text",
      responseUsage: undefined,
      executionStrategy: makeMinimalStrategy(),
      executionJournal: { recordVerifierResult: vi.fn() } as any,
      selfVerification: makeMinimalSelfVerification(),
      stradaConformance: {} as any,
      taskStartedAtMs: Date.now(),
      currentToolNames: [],
      currentAssignment: makeMinimalAssignment(),
      interventionDeps: makeMinimalInterventionDeps(),
      session: makeMinimalSession(),
      usageHandler: undefined,
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      progressAssessmentEnabled: false,
      controlLoopTracker: { markVerificationClean: vi.fn(), markMeaningfulFileEvidence: vi.fn() } as any,
      workerCollector: undefined,
      progressTitle: "Test",
      progressLanguage: "en" as any,
      iteration: 0,
      workspaceLease: undefined,
      systemPrompt: "test",
      daemonMode: true,
      emitProgress: vi.fn(),
      buildStructuredProgressSignal: vi.fn((_p, _t, s) => s) as any,
      getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: {} }) as any,
      formatBoundaryVisibleText: vi.fn((b) => b.visibleText),
      appendVisibleAssistantMessage: vi.fn(),
      synthesizeUserFacingResponse: vi.fn(async () => "handoff draft"),
      persistSessionToMemory: vi.fn(async () => {}),
      getVisibleTranscript: vi.fn(() => []),
    };

    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    const clarificationModule = await import("./orchestrator-clarification.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "none",
    } as any);
    vi.spyOn(originalModule, "resolveVerifierIntervention").mockResolvedValueOnce({
      kind: "approve",
      result: { summary: "ok" },
    } as any);
    vi.spyOn(clarificationModule, "decideUserVisibleBoundary")
      .mockReturnValueOnce({ kind: "final_answer" } as any)
      .mockReturnValueOnce({
        kind: "internal_continue",
        gate: "[VISIBILITY LOOP] Continue internally.",
      } as any);
    const recoverySpy = vi.spyOn(originalModule, "handleBackgroundLoopRecovery").mockResolvedValueOnce({
      action: "continue",
      gate: "[VISIBILITY LOOP] Continue internally.",
    } as any);

    const result = await handleBgEndTurn(agentState, ctx);

    expect(recoverySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonMode: true,
        kind: "visibility_internal_continue",
      }),
      expect.anything(),
    );
    expect(result.flow).toBe("continue");
    expect((ctx.session as any).messages).toContainEqual({
      role: "user",
      content: "[VISIBILITY LOOP] Continue internally.",
    });

    vi.restoreAllMocks();
  });
});

// ─── Interactive End Turn Tests ────────────────────────────────────────────────

describe("handleInteractiveEndTurn", () => {
  it("returns done with empty response fallback when responseText is undefined", async () => {
    const agentState = createInitialState();
    const ctx: InteractiveEndTurnContext = {
      chatId: "test-chat",
      identityKey: "test-user",
      prompt: "test prompt",
      responseText: undefined,
      responseUsage: undefined,
      executionStrategy: makeMinimalStrategy(),
      executionJournal: {
        recordVerifierResult: vi.fn(),
      } as any,
      selfVerification: makeMinimalSelfVerification(),
      stradaConformance: {} as any,
      taskStartedAtMs: Date.now(),
      currentToolNames: [],
      currentAssignment: makeMinimalAssignment(),
      interventionDeps: makeMinimalInterventionDeps(),
      session: makeMinimalSession(),
      usageHandler: undefined,
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      systemPrompt: "test",
      defaultLanguage: "en",
      profileLanguage: undefined,
      runTextConsensusIfCritical: vi.fn(async () => {}),
    };

    // Mock clarification to return passthrough (no intervention)
    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "passthrough",
    } as any);
    vi.spyOn(originalModule, "resolveVerifierIntervention").mockResolvedValueOnce({
      kind: "approve",
      result: { approved: true, summary: "ok", stages: [] },
    } as any);

    const result = await handleInteractiveEndTurn(agentState, ctx);

    expect(result.flow).toBe("done");
    if (result.flow === "done") {
      expect(result.visibleText).toContain("I wasn't able to generate a response");
    }

    vi.restoreAllMocks();
  });

  it("returns done with fallback in Turkish when profileLanguage is tr", async () => {
    const agentState = createInitialState();
    const ctx: InteractiveEndTurnContext = {
      chatId: "test-chat",
      identityKey: "test-user",
      prompt: "test prompt",
      responseText: undefined,
      responseUsage: undefined,
      executionStrategy: makeMinimalStrategy(),
      executionJournal: {
        recordVerifierResult: vi.fn(),
      } as any,
      selfVerification: makeMinimalSelfVerification(),
      stradaConformance: {} as any,
      taskStartedAtMs: Date.now(),
      currentToolNames: [],
      currentAssignment: makeMinimalAssignment(),
      interventionDeps: makeMinimalInterventionDeps(),
      session: makeMinimalSession(),
      usageHandler: undefined,
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      systemPrompt: "test",
      defaultLanguage: "en",
      profileLanguage: "tr",
      runTextConsensusIfCritical: vi.fn(async () => {}),
    };

    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "passthrough",
    } as any);
    vi.spyOn(originalModule, "resolveVerifierIntervention").mockResolvedValueOnce({
      kind: "approve",
      result: { approved: true, summary: "ok", stages: [] },
    } as any);

    const result = await handleInteractiveEndTurn(agentState, ctx);

    expect(result.flow).toBe("done");
    if (result.flow === "done") {
      expect(result.visibleText).toContain("yeniden ifade");
    }

    vi.restoreAllMocks();
  });

  it("returns continue when clarification returns internal continue gate", async () => {
    const agentState = createInitialState();
    const ctx: InteractiveEndTurnContext = {
      chatId: "test-chat",
      identityKey: "test-user",
      prompt: "test prompt",
      responseText: "some draft",
      responseUsage: undefined,
      executionStrategy: makeMinimalStrategy(),
      executionJournal: {
        recordVerifierResult: vi.fn(),
      } as any,
      selfVerification: makeMinimalSelfVerification(),
      stradaConformance: {} as any,
      taskStartedAtMs: Date.now(),
      currentToolNames: [],
      currentAssignment: makeMinimalAssignment(),
      interventionDeps: makeMinimalInterventionDeps(),
      session: makeMinimalSession(),
      usageHandler: undefined,
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      systemPrompt: "test",
      defaultLanguage: "en",
      profileLanguage: undefined,
      runTextConsensusIfCritical: vi.fn(async () => {}),
    };

    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "continue",
      gate: "Please continue working on this.",
    } as any);

    const result = await handleInteractiveEndTurn(agentState, ctx);

    expect(result.flow).toBe("continue");
    // Session should have the gate message pushed
    expect(ctx.session.messages).toHaveLength(2); // assistant + user gate
    expect(ctx.session.messages[1].content).toBe("Please continue working on this.");

    vi.restoreAllMocks();
  });

  it("routes clarification internal-continue through loop recovery when tracker is present", async () => {
    const agentState = createInitialState();
    const ctx: InteractiveEndTurnContext = {
      chatId: "test-chat",
      identityKey: "test-user",
      prompt: "test prompt",
      responseText: "some draft",
      responseUsage: undefined,
      executionStrategy: makeMinimalStrategy(),
      executionJournal: {
        recordVerifierResult: vi.fn(),
      } as any,
      selfVerification: makeMinimalSelfVerification(),
      stradaConformance: {} as any,
      taskStartedAtMs: Date.now(),
      currentToolNames: [],
      currentAssignment: makeMinimalAssignment(),
      interventionDeps: makeMinimalInterventionDeps(),
      session: makeMinimalSession(),
      usageHandler: undefined,
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      systemPrompt: "test",
      defaultLanguage: "en",
      profileLanguage: undefined,
      progressAssessmentEnabled: false,
      controlLoopTracker: {
        getConsecutiveTextOnlyGates: vi.fn().mockReturnValue(1),
        recordGate: vi.fn().mockReturnValue(null),
        markRecoveryAttempt: vi.fn().mockReturnValue(1),
        hardCapReplan: 5,
        hardCapBlock: 8,
      } as any,
      runTextConsensusIfCritical: vi.fn(async () => {}),
    };

    const originalModule = await import("./orchestrator-intervention-pipeline.js");
    vi.spyOn(originalModule, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "continue",
      gate: "Please continue working on this.",
    } as any);
    vi.spyOn(originalModule, "handleBackgroundLoopRecovery").mockResolvedValueOnce({
      action: "replan",
      gate: "[LOOP RECOVERY] Switch to tool execution.",
      summary: "Clarification loop detected.",
    } as any);

    const result = await handleInteractiveEndTurn(agentState, ctx);

    expect(result.flow).toBe("continue");
    if (result.flow === "continue") {
      expect(result.newState.phase).toBe(AgentPhase.REPLANNING);
    }
    expect(ctx.session.messages[1].content).toBe("[LOOP RECOVERY] Switch to tool execution.");

    vi.restoreAllMocks();
  });
});
