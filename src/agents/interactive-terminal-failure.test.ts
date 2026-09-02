/**
 * An honest "I could not do it" in interactive mode settles as failed.
 *
 * audited 2026-09-02: the background end-turn path maps a terminal_failure
 * boundary to status "failed" (the false-green chain the campaign audit
 * traced). The interactive end-turn handler tested only
 * plan_review|blocked|ask_user at its visibility step, so a terminal_failure
 * fell into the approved path: phase recorded "approved", flow done with no
 * status, run settled completed. It also never passed
 * terminalFailureReported into the decision, dropping the second signal the
 * background path feeds the boundary. The interactive reflection DONE handler
 * had the same missing arm.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleInteractiveEndTurn, type InteractiveEndTurnContext } from "./orchestrator-end-turn-handler.js";
import { handleInteractiveReflectionDone, type InteractiveReflectionContext } from "./orchestrator-reflection-handler.js";
import { createInitialState, AgentPhase, transitionPhase } from "./agent-state.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-interactive-terminal-failure-test.log"); } catch { /* set up already */ }
});

const assignment = () =>
  ({ providerName: "p", modelId: "m", role: "executor" as const }) as any;

/**
 * A blocker the boundary classifies as terminal_failure on its own (deploy +
 * approval), phrased so the clarification review does not claim it first.
 */
const BLOCKER =
  "I could not finish: the deployment requires approval from an account owner. " +
  "Please grant access and I will retry.";

function core() {
  return {
    chatId: "c",
    identityKey: "u",
    prompt: "deploy the build",
    responseText: BLOCKER,
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
    progressAssessmentEnabled: false,
  };
}

const endTurnCtx = () =>
  ({
    ...core(),
    defaultLanguage: "en",
    profileLanguage: undefined,
    runTextConsensusIfCritical: vi.fn(async () => {}),
  }) as unknown as InteractiveEndTurnContext;

const reflecting = () =>
  transitionPhase(transitionPhase(createInitialState("deploy the build"), AgentPhase.EXECUTING), AgentPhase.REFLECTING);

describe("interactive end-turn on a terminal blocker", () => {
  it("settles as failed with the blocker as the visible text", async () => {
    const ctx = endTurnCtx();
    const result = await handleInteractiveEndTurn(createInitialState("deploy the build"), ctx);

    expect(result.flow).toBe("done");
    if (result.flow !== "done") throw new Error("expected done");
    expect(result.visibleText).toContain("requires approval");
    expect(result.status).toBe("failed");
  });

  it("records the phase as failed, not approved", async () => {
    const ctx = endTurnCtx();
    await handleInteractiveEndTurn(createInitialState("deploy the build"), ctx);

    expect(ctx.recordPhaseOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(ctx.recordPhaseOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });
});

describe("interactive reflection DONE on a terminal blocker", () => {
  it("settles as failed, not approved", async () => {
    const ctx = core() as unknown as InteractiveReflectionContext;
    const result = await handleInteractiveReflectionDone(reflecting(), ctx);

    expect(result.flow).toBe("done");
    if (result.flow !== "done") throw new Error("expected done");
    expect(result.status).toBe("failed");
    expect(ctx.recordPhaseOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });
});
