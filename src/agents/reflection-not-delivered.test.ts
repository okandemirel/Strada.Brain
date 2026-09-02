/**
 * The reflection DONE route is the other terminal handler, and it must keep
 * the same delivery accounting the end-turn route keeps.
 *
 * audited 2026-09-02: `end-turn-not-delivered.test.ts` proved handleBgEndTurn
 * appends NOT DELIVERED and settles blocked when
 * stradaConformance.unmetDeliveryConditions() is non-empty. A background run
 * that finishes through REFLECTING (the normal route once the agent reflects
 * and says done — reflection.ts sends DONE there and the v2 runner never falls
 * through to end-turn) reached completeBgReflectionDone, which recorded
 * "approved" and returned flow:"done" with no status. Run 52's exact failure —
 * a bare success message for a game that never rendered — was still reachable
 * through this door. The interactive reflection approved path had the same
 * omission.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  handleBgReflectionDone,
  handleInteractiveReflectionDone,
  type BgReflectionContext,
  type InteractiveReflectionContext,
} from "./orchestrator-reflection-handler.js";
import { createInitialState, AgentPhase, transitionPhase } from "./agent-state.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-reflection-not-delivered-test.log"); } catch { /* set up already */ }
});

const assignment = () =>
  ({ providerName: "p", modelId: "m", role: "executor" as const }) as any;

function reflectingState() {
  const executing = transitionPhase(createInitialState("build the game"), AgentPhase.EXECUTING);
  return transitionPhase(executing, AgentPhase.REFLECTING);
}

const DRAFT = "Implemented the board module and its tests.";

/** Shared core: everything downstream of the draft approves. */
function coreThatApproves(unmet: readonly string[]) {
  return {
    chatId: "c",
    identityKey: "u",
    prompt: "build the game",
    responseText: DRAFT,
    responseUsage: undefined,
    toolCallCount: 0,
    executionStrategy: {
      task: { type: "code_generation", criticality: "normal" },
      executor: assignment(), reviewer: assignment(),
      synthesizer: assignment(), planReviewer: assignment(),
    } as any,
    executionJournal: { recordVerifierResult: vi.fn() } as any,
    selfVerification: {
      getState: () => ({ touchedFiles: [], hasCompilableChanges: false }),
      needsVerification: () => false,
      getPrompt: () => null,
    } as any,
    stradaConformance: {
      getPrompt: () => null,
      unmetDeliveryConditions: () => unmet,
    } as any,
    taskStartedAtMs: Date.now(),
    currentToolNames: [],
    currentAssignment: assignment(),
    interventionDeps: {
      buildSupervisorRolePrompt: vi.fn().mockReturnValue(""),
      systemPrompt: "s",
      clarificationContext: { interactionConfig: {}, toolMetadataByName: {} },
      stripInternalDecisionMarkers: vi.fn((t: string) => t ?? ""),
      interactionPolicy: { requirePlanReview: vi.fn() },
      formatPlanReviewMessage: vi.fn((d: string) => d),
      recordExecutionTrace: vi.fn(),
      recordAuxiliaryUsage: vi.fn(),
      recordPhaseOutcome: vi.fn(),
      buildPhaseOutcomeTelemetry: vi.fn(),
      recordRuntimeArtifactEvaluation: vi.fn(),
      getTaskRunId: vi.fn(),
      synthesizeUserFacingResponse: vi.fn(async (p: any) => p.draft || ""),
      runCompletionReviewStages: vi.fn(async () => ({ stages: [], finalDecision: "approve" })),
      runVisibilityReview: vi.fn(async () => ({ decision: { decision: "allow", reason: "ok" } })),
      executeToolCalls: vi.fn(async () => []),
      getLogRingBuffer: vi.fn(() => []),
      buildStructuredProgressSignal: vi.fn((_p: any, _t: any, s: any) => s),
    } as any,
    session: { messages: [] as any[] } as any,
    usageHandler: undefined,
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn(),
    systemPrompt: "s",
  };
}

function bgContextThatApproves(unmet: readonly string[]): BgReflectionContext {
  return {
    ...coreThatApproves(unmet),
    progressAssessmentEnabled: false,
    controlLoopTracker: {
      markVerificationClean: vi.fn(), markMeaningfulFileEvidence: vi.fn(),
    } as any,
    workerCollector: undefined,
    progressTitle: "T",
    progressLanguage: "en" as any,
    iteration: 0,
    workspaceLease: undefined,
    emitProgress: vi.fn(),
    buildStructuredProgressSignal: vi.fn((_p: any, _t: any, s: any) => s) as any,
    getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: {} }) as any,
    formatBoundaryVisibleText: vi.fn((b: any) => b.visibleText),
    appendVisibleAssistantMessage: vi.fn(),
    synthesizeUserFacingResponse: vi.fn(async (p: any) => p.draft),
    persistSessionToMemory: vi.fn(async () => {}),
    getVisibleTranscript: vi.fn(() => []),
  } as unknown as BgReflectionContext;
}

function interactiveContextThatApproves(unmet: readonly string[]): InteractiveReflectionContext {
  return {
    ...coreThatApproves(unmet),
    progressAssessmentEnabled: false,
  } as unknown as InteractiveReflectionContext;
}

const NOT_DRAWN = "the game has never been observed to render: all 60 captured frames are identical";

describe("background reflection DONE with an unmet delivery condition", () => {
  it("does not report completion", async () => {
    const result = await handleBgReflectionDone(reflectingState(), bgContextThatApproves([NOT_DRAWN]));

    expect(result.flow).toBe("done");
    if (result.flow === "done") expect(result.status).toBe("blocked");
  });

  it("names the condition in what the user reads, keeping the work reported", async () => {
    const result = await handleBgReflectionDone(reflectingState(), bgContextThatApproves([NOT_DRAWN]));

    if (result.flow !== "done") throw new Error("expected done");
    expect(result.visibleText).toContain("NOT DELIVERED");
    expect(result.visibleText).toContain("all 60 captured frames are identical");
    expect(result.visibleText).toContain("Implemented the board module");
  });

  it("records the phase as blocked with the reason, not approved", async () => {
    const ctx = bgContextThatApproves([NOT_DRAWN]);
    await handleBgReflectionDone(reflectingState(), ctx);

    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked", reason: NOT_DRAWN }),
    );
    expect(ctx.recordPhaseOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved" }),
    );
  });

  it("completes exactly as before when nothing is outstanding", async () => {
    const ctx = bgContextThatApproves([]);
    const result = await handleBgReflectionDone(reflectingState(), ctx);

    expect(result.flow).toBe("done");
    if (result.flow === "done") {
      expect(result.status).toBeUndefined();
      expect(result.visibleText).not.toContain("NOT DELIVERED");
    }
    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });
});

describe("interactive reflection DONE with an unmet delivery condition", () => {
  it("does not report completion and names the condition", async () => {
    const ctx = interactiveContextThatApproves([NOT_DRAWN]);
    const result = await handleInteractiveReflectionDone(reflectingState(), ctx);

    expect(result.flow).toBe("done");
    if (result.flow !== "done") throw new Error("expected done");
    expect(result.status).toBe("blocked");
    expect(result.visibleText).toContain("NOT DELIVERED");
    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked", reason: NOT_DRAWN }),
    );
  });

  it("completes as before when nothing is outstanding", async () => {
    const ctx = interactiveContextThatApproves([]);
    const result = await handleInteractiveReflectionDone(reflectingState(), ctx);

    expect(result.flow).toBe("done");
    if (result.flow === "done") expect(result.status).toBeUndefined();
    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });
});
