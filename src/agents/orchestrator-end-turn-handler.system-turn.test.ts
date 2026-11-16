/**
 * The end-turn handler's gates are not what the user last said.
 *
 * When the end-turn handler sends the model back to work, it pushes a gate as a
 * plain-text user turn: the visibility boundary's internal-continue
 * (4a, its own push) and the clarification, verifier and loop-recovery gates
 * (pushContinuationMessages). The session manager's last-user-message read
 * returned that gate as the person's words. Both pushes now go through
 * pushSystemTurn, which the read passes over.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { handleInteractiveEndTurn, type InteractiveEndTurnContext } from "./orchestrator-end-turn-handler.js";
import * as pipeline from "./orchestrator-intervention-pipeline.js";
import { SessionManager } from "./orchestrator-session-manager.js";
import { createInitialState } from "./agent-state.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  try { createLogger("error", "/tmp/strada-end-turn-system-turn-test.log"); } catch { /* already initialized */ }
});
afterEach(() => vi.restoreAllMocks());

const SAID = "add a dark-mode toggle to the settings screen";
const VISIBILITY_GATE = "[VISIBILITY] That draft is an internal plan; carry it out before answering.";
const CLARIFICATION_GATE = "[CLARIFICATION] Do not ask; the request names the screen.";

function sessionManager(): SessionManager {
  return new SessionManager({
    channel: { sendText: vi.fn(), sendMarkdown: vi.fn() },
    interactionPolicy: { get: vi.fn() },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
  } as unknown as ConstructorParameters<typeof SessionManager>[0]);
}

function context(session: InteractiveEndTurnContext["session"]): InteractiveEndTurnContext {
  const assignment = { providerName: "p", modelId: "m", role: "executor" } as never;
  return {
    chatId: "chat-1",
    identityKey: "id-1",
    prompt: SAID,
    responseText: "## Plan\n1. Open the settings screen",
    responseUsage: undefined,
    executionStrategy: { task: { type: "code_generation", criticality: "normal" }, executor: assignment, reviewer: assignment, synthesizer: assignment } as never,
    executionJournal: { recordVerifierResult: vi.fn() } as never,
    selfVerification: { getState: () => ({ touchedFiles: new Set(), lastBuildOk: true, lastVerificationAt: null }) } as never,
    stradaConformance: {} as never,
    taskStartedAtMs: Date.now(),
    currentToolNames: [],
    currentAssignment: assignment,
    interventionDeps: { recordPhaseOutcome: vi.fn(), buildPhaseOutcomeTelemetry: vi.fn() } as never,
    session,
    usageHandler: undefined,
    recordPhaseOutcome: vi.fn(),
    buildPhaseOutcomeTelemetry: vi.fn(),
    systemPrompt: "sys",
    defaultLanguage: "en",
    profileLanguage: undefined,
    runTextConsensusIfCritical: vi.fn(async () => {}),
  } as InteractiveEndTurnContext;
}

function interactiveSession() {
  const sm = sessionManager();
  const session = sm.getOrCreateSession("chat-1");
  sm.appendVisibleUserMessage(session, SAID);
  return { sm, session };
}

describe("an end-turn gate is not the user's last message", () => {
  it("the visibility boundary's internal continue (4a)", async () => {
    const { sm, session } = interactiveSession();
    vi.spyOn(pipeline, "resolveDraftClarificationIntervention").mockResolvedValueOnce({ kind: "passthrough" } as never);
    vi.spyOn(pipeline, "resolveVerifierIntervention").mockResolvedValueOnce({
      kind: "approve",
      result: { approved: true, summary: "ok", stages: [] },
    } as never);
    vi.spyOn(pipeline, "resolveVisibleDraftDecision").mockResolvedValueOnce({
      kind: "internal_continue",
      gate: VISIBILITY_GATE,
      reason: "internal plan artifact",
    } as never);

    const result = await handleInteractiveEndTurn(createInitialState(SAID), context(session));

    expect(result.flow).toBe("continue");
    expect(session.messages.at(-1)).toMatchObject({ role: "user", content: VISIBILITY_GATE });
    expect(sm.extractLastUserMessage(session)).toBe(SAID);
  });

  it("a clarification gate (pushContinuationMessages)", async () => {
    const { sm, session } = interactiveSession();
    vi.spyOn(pipeline, "resolveDraftClarificationIntervention").mockResolvedValueOnce({
      kind: "continue",
      gate: CLARIFICATION_GATE,
    } as never);

    const result = await handleInteractiveEndTurn(createInitialState(SAID), context(session));

    expect(result.flow).toBe("continue");
    expect(session.messages.at(-1)).toMatchObject({ role: "user", content: CLARIFICATION_GATE });
    expect(sm.extractLastUserMessage(session)).toBe(SAID);
  });
});
