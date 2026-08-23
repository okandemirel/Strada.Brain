/**
 * A run that every verifier approved, reporting what it did not deliver.
 *
 * Measured on run 52: [STRADA NOTHING DRAWN] fired three times, fell silent when
 * its ask budget ran out, and the task finished `failed: false` with a
 * 123-character success message for a game whose sixty captured frames were
 * identical. The gates are asks and an ask must be able to give up; what must
 * not give up is the accounting of whether the thing asked for exists.
 *
 * Blocked, not failed: nothing went wrong, the work simply stopped short, and
 * blocked is what the resume and replan paths already read as "more to do".
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleBgEndTurn } from "./orchestrator-end-turn-handler.js";
import type { BgEndTurnContext } from "./orchestrator-end-turn-handler.js";
import { createInitialState } from "./agent-state.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-not-delivered-test.log"); } catch { /* set up already */ }
});

const assignment = () =>
  ({ providerName: "p", modelId: "m", role: "executor" as const }) as any;

/** A context that runs straight through to the approved path. */
function contextThatApproves(unmet: readonly string[]): BgEndTurnContext {
  return {
    chatId: "c",
    identityKey: "u",
    prompt: "build the game",
    responseText: "Implemented the board module and its tests.",
    responseUsage: undefined,
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
    progressAssessmentEnabled: false,
    controlLoopTracker: {
      markVerificationClean: vi.fn(), markMeaningfulFileEvidence: vi.fn(),
    } as any,
    workerCollector: undefined,
    progressTitle: "T",
    progressLanguage: "en" as any,
    iteration: 0,
    workspaceLease: undefined,
    systemPrompt: "s",
    emitProgress: vi.fn(),
    buildStructuredProgressSignal: vi.fn((_p: any, _t: any, s: any) => s) as any,
    getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: {} }) as any,
    formatBoundaryVisibleText: vi.fn((b: any) => b.visibleText),
    appendVisibleAssistantMessage: vi.fn(),
    synthesizeUserFacingResponse: vi.fn(async (p: any) => p.draft),
    persistSessionToMemory: vi.fn(async () => {}),
    getVisibleTranscript: vi.fn(() => []),
  } as unknown as BgEndTurnContext;
}

const NOT_DRAWN = "the game has never been observed to render: all 60 captured frames are identical";

describe("a run with an unmet delivery condition", () => {
  it("does not report completion", async () => {
    const result = await handleBgEndTurn(createInitialState(), contextThatApproves([NOT_DRAWN]));

    expect(result.flow).toBe("done");
    if (result.flow === "done") expect(result.status).toBe("blocked");
  });

  it("names the condition in what the user reads", async () => {
    const result = await handleBgEndTurn(createInitialState(), contextThatApproves([NOT_DRAWN]));

    if (result.flow !== "done") throw new Error("expected done");
    expect(result.visibleText).toContain("NOT DELIVERED");
    expect(result.visibleText).toContain("all 60 captured frames are identical");
  });

  it("keeps the work the run did report", async () => {
    // The code is real and the user should still see it; what changes is the
    // claim made about it.
    const result = await handleBgEndTurn(createInitialState(), contextThatApproves([NOT_DRAWN]));

    if (result.flow !== "done") throw new Error("expected done");
    expect(result.visibleText).toContain("Implemented the board module");
  });

  it("records the phase as blocked, with the reason", async () => {
    const ctx = contextThatApproves([NOT_DRAWN]);
    await handleBgEndTurn(createInitialState(), ctx);

    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked", reason: NOT_DRAWN }),
    );
  });

  it("lists every condition when more than one is outstanding", async () => {
    const ctx = contextThatApproves([NOT_DRAWN, "no playable level exists"]);
    const result = await handleBgEndTurn(createInitialState(), ctx);

    if (result.flow !== "done") throw new Error("expected done");
    expect(result.visibleText).toContain("no playable level exists");
    expect(result.visibleText).toContain("all 60 captured frames are identical");
  });
});

describe("a run with nothing outstanding", () => {
  it("completes exactly as before", async () => {
    const ctx = contextThatApproves([]);
    const result = await handleBgEndTurn(createInitialState(), ctx);

    expect(result.flow).toBe("done");
    if (result.flow === "done") {
      expect(result.status).toBeUndefined();
      expect(result.visibleText).not.toContain("NOT DELIVERED");
    }
    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved" }),
    );
  });
});
