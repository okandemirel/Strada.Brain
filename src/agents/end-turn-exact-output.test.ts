/**
 * A "reply with only X" request must surface exactly X even when the end-turn
 * handler skips synthesis for a trivial reply. Synthesis applied the contract;
 * the bypass surfaced the model's whole draft.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleBgEndTurn } from "./orchestrator-end-turn-handler.js";
import type { BgEndTurnContext } from "./orchestrator-end-turn-handler.js";
import { createInitialState } from "./agent-state.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-end-turn-exact-output-test.log"); } catch { /* already initialized */ }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeContext(prompt: string, responseText: string, synthesize: BgEndTurnContext["synthesizeUserFacingResponse"]): BgEndTurnContext {
  const assignment = { providerName: "test-provider", modelId: "test-model", role: "executor" } as never;
  return {
    chatId: "test-chat",
    identityKey: "test-user",
    prompt,
    responseText,
    responseUsage: undefined,
    executionStrategy: {
      task: { type: "conversational", criticality: "normal" },
      executor: assignment,
      reviewer: assignment,
      synthesizer: assignment,
      planReviewer: assignment,
    } as never,
    taskClassification: { type: "conversational", complexity: "trivial", criticality: "low" } as never,
    executionJournal: { recordVerifierResult: vi.fn() } as never,
    selfVerification: {
      getState: () => ({ touchedFiles: new Set<string>(), lastBuildOk: true, lastVerificationAt: null }),
    } as never,
    stradaConformance: { unmetDeliveryConditions: () => [] } as never,
    taskStartedAtMs: Date.now(),
    currentToolNames: [],
    currentAssignment: assignment,
    interventionDeps: {} as never,
    session: { messages: [], createdAt: Date.now(), lastActiveAt: Date.now() } as never,
    usageHandler: undefined,
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn(),
    progressAssessmentEnabled: false,
    controlLoopTracker: { markVerificationClean: vi.fn(), markMeaningfulFileEvidence: vi.fn() } as never,
    workerCollector: undefined,
    progressTitle: "Test",
    progressLanguage: "en" as never,
    iteration: 0,
    workspaceLease: undefined,
    systemPrompt: "test",
    emitProgress: vi.fn(),
    buildStructuredProgressSignal: vi.fn((_p, _t, s) => s) as never,
    getClarificationContext: () => ({ interactionConfig: {}, toolMetadataByName: {} }) as never,
    formatBoundaryVisibleText: vi.fn((b: { visibleText?: string }) => b.visibleText) as never,
    appendVisibleAssistantMessage: vi.fn(),
    synthesizeUserFacingResponse: synthesize,
    persistSessionToMemory: vi.fn(async () => {}),
    getVisibleTranscript: vi.fn(() => []),
  };
}

async function stubPipelines() {
  const pipeline = await import("./orchestrator-intervention-pipeline.js");
  const clarification = await import("./orchestrator-clarification.js");
  vi.spyOn(pipeline, "resolveDraftClarificationIntervention").mockResolvedValue({ kind: "none" } as never);
  vi.spyOn(pipeline, "resolveVerifierIntervention").mockResolvedValue({ kind: "approve", result: { summary: "ok" } } as never);
  return vi.spyOn(clarification, "decideUserVisibleBoundary").mockReturnValue({ kind: "final_answer" } as never);
}

describe("handleBgEndTurn exact-output contract when synthesis is skipped", () => {
  it("surfaces only the requested literal", async () => {
    const boundary = await stubPipelines();
    const synthesize = vi.fn(async (p: { draft: string }) => p.draft);
    const ctx = makeContext('Reply with only: "Atlas"', "Atlas\nExtra details that should never reach the user.", synthesize);

    const result = await handleBgEndTurn(createInitialState(), ctx);

    // The trivial conversational reply bypasses synthesis...
    expect(synthesize).not.toHaveBeenCalled();
    // ...and still surfaces the literal alone.
    expect(boundary).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ visibleDraft: "Atlas" }));
    expect(result.flow).toBe("done");
    if (result.flow === "done") expect(result.visibleText).toBe("Atlas");
  });

  it("leaves an ordinary trivial reply as drafted", async () => {
    const boundary = await stubPipelines();
    const ctx = makeContext("hello there", "Hi! How can I help?", vi.fn(async (p: { draft: string }) => p.draft));

    const result = await handleBgEndTurn(createInitialState(), ctx);

    expect(boundary).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ visibleDraft: "Hi! How can I help?" }));
    if (result.flow === "done") expect(result.visibleText).toBe("Hi! How can I help?");
  });
});
