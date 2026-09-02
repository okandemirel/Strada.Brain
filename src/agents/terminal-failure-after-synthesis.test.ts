/**
 * A terminal failure the second boundary sees must settle the run as failed.
 *
 * audited 2026-09-02: both background end-turn paths run the visibility
 * boundary twice — once on the raw draft, once on the synthesized prose. The
 * first call maps plan_review/terminal_failure to blocked/failed; the second
 * tested only internal_continue. A raw draft whose head buries the blocker
 * under a bullet list reads as final_answer, synthesis rewrites it into the
 * "please sign in to your account" phrasing the boundary keys on, and the
 * second boundary returns terminal_failure — which then fell into the
 * approved finish path: status "approved", reason "the verifier pipeline
 * cleared the task", flow done with no status. A campaign milestone greened
 * on a run that had just said it could not do the work.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleBgEndTurn, type BgEndTurnContext } from "./orchestrator-end-turn-handler.js";
import { handleBgReflectionDone, type BgReflectionContext } from "./orchestrator-reflection-handler.js";
import { createInitialState, AgentPhase, transitionPhase } from "./agent-state.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-terminal-failure-synth-test.log"); } catch { /* set up already */ }
});

const assignment = () =>
  ({ providerName: "p", modelId: "m", role: "executor" as const }) as any;

/**
 * Head carries no external-dependency word; the boundary truncates at the
 * numbered list, so the head alone is judged (a "- " list would instead send
 * the draft to the clarification review, which is not the path under test).
 */
const RAW_DRAFT =
  "Unity build did not run: the editor returned a licence check error and I stopped there.\n" +
  "1. Tried the batchmode build twice\n" +
  "2. Checked the editor log";

/** What synthesis makes of it: fronted, user-actionable, external dependency. */
const SYNTHESIZED =
  "The Unity licence has expired. Please sign in to your Unity account and re-run the build.";

function bgCore() {
  return {
    chatId: "c",
    identityKey: "u",
    prompt: "build the game",
    responseText: RAW_DRAFT,
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
    stradaConformance: { getPrompt: () => null, unmetDeliveryConditions: () => [] } as any,
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
      synthesizeUserFacingResponse: vi.fn(async () => SYNTHESIZED),
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
    synthesizeUserFacingResponse: vi.fn(async () => SYNTHESIZED),
    persistSessionToMemory: vi.fn(async () => {}),
    getVisibleTranscript: vi.fn(() => []),
  };
}

const reflecting = () =>
  transitionPhase(transitionPhase(createInitialState("build the game"), AgentPhase.EXECUTING), AgentPhase.REFLECTING);

describe("background end-turn: terminal_failure raised after synthesis", () => {
  it("settles the run as failed, not approved", async () => {
    const ctx = bgCore() as unknown as BgEndTurnContext;
    const result = await handleBgEndTurn(createInitialState(), ctx);

    // Premise: synthesis ran and the surfaced text is the blocker.
    expect(ctx.synthesizeUserFacingResponse).toHaveBeenCalled();
    expect(result.flow).toBe("done");
    if (result.flow !== "done") throw new Error("expected done");
    expect(result.visibleText).toContain("sign in to your Unity account");
    expect(result.status).toBe("failed");
    expect(ctx.recordPhaseOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved" }),
    );
  });
});

describe("background reflection DONE: terminal_failure raised after synthesis", () => {
  it("settles the run as failed, not approved", async () => {
    const ctx = bgCore() as unknown as BgReflectionContext;
    const result = await handleBgReflectionDone(reflecting(), ctx);

    expect(ctx.synthesizeUserFacingResponse).toHaveBeenCalled();
    expect(result.flow).toBe("done");
    if (result.flow !== "done") throw new Error("expected done");
    expect(result.visibleText).toContain("sign in to your Unity account");
    expect(result.status).toBe("failed");
    expect(ctx.recordPhaseOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved" }),
    );
  });
});
